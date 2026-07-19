/**
 * Canonical coverage honesty (implementation plan §8.4, §10, §11).
 *
 * Coverage completeness is decided by the deterministic run state, not by anything
 * the model claims. The evidence layer knows exactly which mandatory activity
 * windows and which large whole-recording gaps remain uninspected; those are the
 * canonical "uncovered segments". This module turns that runtime state into repair
 * errors so a submission cannot lie about coverage in either direction:
 *
 *   - a `complete` submission is rejected while ANY canonical segment is uncovered;
 *   - a `partial` submission must list every canonical uncovered segment in its
 *     declared `coverage.uninspectedRanges` (each segment must be contained in the
 *     union of the declared ranges), instead of inventing arbitrary claims.
 *
 * It is pure and deterministic, so both the analyst and the reviewer submit
 * validators share it and it is unit-testable without a model.
 */
import type { SubmitAnalysisPayload } from "../contracts/analysis-v1.ts";
import type { InspectionStatus } from "../evidence/inspection-context.ts";

export interface UncoveredSegment {
	startMs: number;
	endMs: number;
	/** Why this segment is canonically uncovered (mandatory window vs. large gap). */
	reason: string;
	/** The constrained tool/resource that can satisfy this obligation. */
	requiredTool?: "inspect_range" | "inspect_frame" | "uncoverable";
	/** Deterministic registered IDs for an isolated peak's required full-resolution read. */
	frameIds?: string[];
}

/**
 * The canonical set of uncovered segments for the current run: every uninspected
 * mandatory activity window plus every large uninspected whole-recording gap.
 */
export function computeUncoveredSegments(status: InspectionStatus): UncoveredSegment[] {
	const segments: UncoveredSegment[] = [];
	for (const window of status.mandatoryWindows) {
		if (!window.uninspected) continue;
		// Span coverage and isolated-peak full-resolution reads are INDEPENDENT
		// obligations. When both remain on the same mandatory window, emit BOTH so
		// resource-aware partial validation cannot silently drop either repair path.
		const needsFullRes = (window.peakOrdinalsNeedingFullRes ?? []).length > 0;
		const spanUncovered = (window.uncoveredSubsegments ?? []).length > 0;

		// Report the CANONICAL uncovered sub-parts (genuine gaps wider than one frame),
		// not the whole window, so a partially-inspected window is described precisely
		// and sampled sub-frame slivers are never flagged. For a non-peak uninspected
		// window with no detail, fall back to the whole window. A peak-only window must
		// not invent a range obligation after its span has already been covered.
		if (spanUncovered || !needsFullRes) {
			const subsegments = spanUncovered
				? window.uncoveredSubsegments!
				: [{ startMs: window.startMs, endMs: window.endMs }];
			for (const seg of subsegments) {
				segments.push({
					startMs: seg.startMs,
					endMs: seg.endMs,
					reason: "mandatory activity window",
					requiredTool: "inspect_range",
				});
			}
		}

		if (needsFullRes) {
			segments.push({
				startMs: window.startMs,
				endMs: window.endMs,
				reason: "isolated transient peak needing a full-resolution read",
				requiredTool: "inspect_frame",
				...(window.peakFrameIds && window.peakFrameIds.length > 0 ? { frameIds: [...window.peakFrameIds] } : {}),
			});
		}
	}
	for (const gap of status.largeGaps) {
		segments.push({
			startMs: gap.startMs,
			endMs: gap.endMs,
			reason: "large uninspected recording gap",
			requiredTool: "inspect_range",
		});
	}
	// Isolated transients that overflowed the deterministic focus budget cannot be
	// satisfied, so a submission must be an HONEST partial that lists them.
	for (const seg of status.unsatisfiedIsolatedTransients ?? []) {
		segments.push({
			startMs: seg.startMs,
			endMs: seg.endMs,
			reason: "isolated transient over the focus budget",
			requiredTool: "uncoverable",
		});
	}
	return segments;
}

/** Merge declared ranges into a minimal ascending set of spans for containment tests. */
function mergeRanges(
	ranges: ReadonlyArray<{ startMs: number; endMs: number }>,
): Array<{ startMs: number; endMs: number }> {
	const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs);
	const merged: Array<{ startMs: number; endMs: number }> = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
		else merged.push({ startMs: range.startMs, endMs: range.endMs });
	}
	return merged;
}

/**
 * Coverage-honesty repair errors for a candidate submission given the canonical
 * uncovered segments. Empty when the submission is honest about coverage.
 */
export function coverageHonestyErrors(payload: SubmitAnalysisPayload, uncovered: UncoveredSegment[]): string[] {
	const errors: string[] = [];

	if (payload.status === "complete") {
		for (const segment of uncovered) {
			const requiredTool = classifyRequiredTool(segment);
			const repair =
				requiredTool === "inspect_frame"
					? `read its registered peak frame at full resolution with inspect_frame${formatFrameIds(segment.frameIds)}`
					: requiredTool === "inspect_range"
						? "inspect it with inspect_range"
						: 'submit status "partial" and list it in coverage.uninspectedRanges';
			errors.push(
				`status is "complete" but the ${segment.reason} ${segment.startMs}-${segment.endMs}ms remains uncovered; ${repair}`,
			);
		}
		return errors;
	}

	// status === "partial": every canonical uncovered segment must be represented.
	const declared = mergeRanges(payload.coverage.uninspectedRanges);
	const contained = (startMs: number, endMs: number): boolean =>
		declared.some((r) => r.startMs <= startMs && r.endMs >= endMs);
	for (const segment of uncovered) {
		if (!contained(segment.startMs, segment.endMs)) {
			errors.push(
				`status is "partial" but the ${segment.reason} ${segment.startMs}-${segment.endMs}ms is not listed in coverage.uninspectedRanges; a partial result must honestly list every uncovered segment`,
			);
		}
	}
	return errors;
}

/** Remaining inspection allowance for the premature-partial guard. */
export interface RemainingAllowance {
	rangeInspections: number;
	cells: number;
	fullResolutionFrames: number;
}

/**
 * `inspect_range` can admit a one-cell request, and a requested multi-sample range
 * may resolve to only one or two source frames. Any remaining cell is therefore
 * spendable range capacity; normal prompt guidance still asks for denser sheets.
 */
const MIN_CELLS_PER_RANGE = 1;
/** Cap how many segments each actionable category lists, so messages stay bounded. */
const MAX_LISTED_SEGMENTS = 6;
const PEAK_REASON = "isolated transient peak needing a full-resolution read";
const UNCOVERABLE_REASON = "isolated transient over the focus budget";

type RequiredTool = NonNullable<UncoveredSegment["requiredTool"]>;

/** Backwards-compatible classification for callers/tests that construct reason-only segments. */
function classifyRequiredTool(segment: UncoveredSegment): RequiredTool {
	if (segment.requiredTool !== undefined) return segment.requiredTool;
	if (segment.reason === UNCOVERABLE_REASON) return "uncoverable";
	if (segment.reason.startsWith(PEAK_REASON)) return "inspect_frame";
	return "inspect_range";
}

function formatFrameIds(frameIds: readonly string[] | undefined): string {
	return frameIds && frameIds.length > 0 ? ` (${frameIds.join(", ")})` : " as listed by get_inspection_status";
}

function listSegments(segments: UncoveredSegment[]): string {
	const listed = segments
		.slice(0, MAX_LISTED_SEGMENTS)
		.map((s) => `${s.startMs}-${s.endMs}ms (${s.reason})`)
		.join(", ");
	const more = segments.length > MAX_LISTED_SEGMENTS ? ` (and ${segments.length - MAX_LISTED_SEGMENTS} more)` : "";
	return `${listed}${more}`;
}

/**
 * Reject a PREMATURE partial: a `partial` submission that still leaves deterministic
 * COVERABLE segments uninspected WHILE sufficient inspection allowance remains. The
 * error is bounded and actionable — it names the remaining allowance and the first
 * few segments — so the analyst/reviewer uses its remaining tools to finish and
 * submit `complete`. A partial stays valid only when nothing coverable remains or
 * the inspection ledger was genuinely exhausted through actual tool use. Provider,
 * timeout, turn, and cancellation failures normally abort without a submission.
 *
 * Applied identically to the analyst and the reviewer submit validators.
 */
export function prematurePartialErrors(
	payload: SubmitAnalysisPayload,
	uncovered: UncoveredSegment[],
	remaining: RemainingAllowance,
): string[] {
	if (payload.status !== "partial") return [];
	if (uncovered.length === 0) {
		return ['status is "partial" but deterministic coverage is complete; submit status "complete" instead'];
	}

	const rangeSegments = uncovered.filter((s) => classifyRequiredTool(s) === "inspect_range");
	const peakSegments = uncovered.filter((s) => classifyRequiredTool(s) === "inspect_frame");
	const errors: string[] = [];

	if (rangeSegments.length > 0 && remaining.rangeInspections >= 1 && remaining.cells >= MIN_CELLS_PER_RANGE) {
		errors.push(
			`status is "partial" but ${rangeSegments.length} range-coverable segment(s) remain and you still have ${remaining.rangeInspections} inspect_range call(s) and ${remaining.cells} cell(s): inspect them with inspect_range, then submit status "complete" once no deterministic obligations remain. First: ${listSegments(rangeSegments)}.`,
		);
	}

	if (peakSegments.length > 0 && remaining.fullResolutionFrames >= 1) {
		const frameIds = [...new Set(peakSegments.flatMap((s) => s.frameIds ?? []))];
		errors.push(
			`status is "partial" but ${peakSegments.length} isolated peak obligation(s) remain and you still have ${remaining.fullResolutionFrames} full-resolution frame read(s): call inspect_frame for the registered peak frame IDs${formatFrameIds(frameIds)}, then re-check inspection status and submit status "complete" once no deterministic obligations remain. First: ${listSegments(peakSegments)}.`,
		);
	}

	return errors;
}
