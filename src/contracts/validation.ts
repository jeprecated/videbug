/**
 * Deterministic semantic and citation validation for a complete `AnalysisResultV1`.
 *
 * This is the post-composition validator described in implementation plan §10. It
 * runs after schema validation and enforces the invariants that TypeBox cannot:
 * temporal bounds, ordering, non-overlap, transient precision, exact evidence
 * citations against the run's evidence registry, transition before/after ordering,
 * anomaly cross-references, and coverage/completeness rules.
 *
 * It never throws on bad input and never trusts model-supplied timestamps: every
 * citation's `ptsMs` must exactly match the registry, which is derived from the
 * deterministic source-PTS frame catalog. Errors are returned as concrete strings
 * suitable for a single agent repair turn and for unit testing.
 */
import { type AnalysisResultV1, validateAnalysisResultSchema } from "./analysis-v1.ts";

/** Read-only view over the run's evidence registry: frame ID -> exact source PTS. */
export interface EvidenceRegistryView {
	resolve(frameId: string): { ptsMs: number } | undefined;
}

export type AnalysisValidationResult = { ok: true; value: AnalysisResultV1 } | { ok: false; errors: string[] };

export interface ValidateOptions {
	registry: EvidenceRegistryView;
	/**
	 * How far short of `source.durationMs` the final analyzed region may fall while
	 * still counting as "the final source region is represented". The last decoded
	 * source frame's PTS is typically one frame interval before the container
	 * duration, so a tolerance of ~one frame interval lets an honest analysis reach
	 * the last frame without inventing precision or a spurious tail uncertainty.
	 * Defaults to 0 (exact) for backwards compatibility.
	 */
	tailToleranceMs?: number;
}

/** Build an `EvidenceRegistryView` from `[frameId, ptsMs]` entries. */
export function evidenceRegistryFromEntries(entries: Iterable<readonly [string, number]>): EvidenceRegistryView {
	const map = new Map<string, number>();
	for (const [frameId, ptsMs] of entries) map.set(frameId, ptsMs);
	return {
		resolve(frameId) {
			const ptsMs = map.get(frameId);
			return ptsMs === undefined ? undefined : { ptsMs };
		},
	};
}

export function validateAnalysisResult(value: unknown, options: ValidateOptions): AnalysisValidationResult {
	const schemaCheck = validateAnalysisResultSchema(value);
	if (!schemaCheck.ok) return { ok: false, errors: schemaCheck.errors };

	const result = schemaCheck.value;
	const errors: string[] = [];

	checkDuration(result, errors);
	checkCoverage(result, options.tailToleranceMs ?? 0, errors);
	checkBeats(result, options.registry, options.tailToleranceMs ?? 0, errors);
	checkAnomalies(result, options.registry, errors);

	if (errors.length > 0) return { ok: false, errors: dedupe(errors) };
	return { ok: true, value: result };
}

function inBounds(label: string, ms: number, durationMs: number, errors: string[]): void {
	if (!Number.isFinite(ms)) {
		errors.push(`${label} is not finite: ${ms}`);
		return;
	}
	if (ms < 0 || ms > durationMs) {
		errors.push(`${label} ${ms}ms is outside the source duration [0, ${durationMs}]`);
	}
}

function checkDuration(result: AnalysisResultV1, errors: string[]): void {
	if (!Number.isFinite(result.source.durationMs) || result.source.durationMs <= 0) {
		errors.push(`source.durationMs must be a positive number, got ${result.source.durationMs}`);
	}
}

function checkCoverage(result: AnalysisResultV1, tailToleranceMs: number, errors: string[]): void {
	const { durationMs } = result.source;
	const { coverage, handoff, status } = result;

	inBounds("coverage.analyzedStartMs", coverage.analyzedStartMs, durationMs, errors);
	inBounds("coverage.analyzedEndMs", coverage.analyzedEndMs, durationMs, errors);
	if (coverage.analyzedStartMs > coverage.analyzedEndMs) {
		errors.push(
			`coverage.analyzedStartMs ${coverage.analyzedStartMs} is after analyzedEndMs ${coverage.analyzedEndMs}`,
		);
	}

	coverage.uninspectedRanges.forEach((range, i) => {
		inBounds(`coverage.uninspectedRanges[${i}].startMs`, range.startMs, durationMs, errors);
		inBounds(`coverage.uninspectedRanges[${i}].endMs`, range.endMs, durationMs, errors);
		if (range.startMs > range.endMs) {
			errors.push(`coverage.uninspectedRanges[${i}] is inverted: ${range.startMs} > ${range.endMs}`);
		}
	});

	if (status === "complete" && coverage.uninspectedRanges.length > 0) {
		errors.push("status is 'complete' but coverage.uninspectedRanges is non-empty");
	}

	const uncertain = handoff.uncertainties.length > 0;
	if (coverage.analyzedStartMs > 0 && !uncertain) {
		errors.push(
			"the first source region is not represented (coverage.analyzedStartMs > 0) and no handoff uncertainty is stated",
		);
	}
	if (coverage.analyzedEndMs < durationMs - Math.max(0, tailToleranceMs) && !uncertain) {
		errors.push(
			"the final source region is not represented (coverage.analyzedEndMs < durationMs) and no handoff uncertainty is stated",
		);
	}
}

/**
 * Fraction of a sustained animated beat's own duration that counts as "near" its
 * start or end edge. General (relative to the beat), never a benchmark constant.
 */
const EDGE_FRACTION = 1 / 3;
/** A local-animation beat spanning at least this many frame intervals is "sustained". */
const SUSTAINED_FRAME_INTERVALS = 8;

/**
 * A SUSTAINED local-animation beat (e.g. a multi-second loading spinner) must be
 * BOUNDED BY EVIDENCE at both ends: it must cite at least one registered frame near
 * its start edge and one near its end edge, so its interval is set from frames that
 * actually show the animated state rather than a single mid-beat frame with
 * loosely-guessed boundaries that spill into the adjacent (loaded) screen.
 *
 * The "near-edge" window is a fraction of the beat's OWN duration (with a small
 * frame-interval floor), so the rule is general and carries no benchmark constant.
 * A near-instant animation is exempt (it has no distinct edges to bound).
 */
function checkAnimatedEdgeEvidence(
	label: string,
	beat: AnalysisResultV1["beats"][number],
	frameIntervalMs: number,
	errors: string[],
): void {
	if (beat.observation.motion !== "local-animation") return;
	const duration = beat.time.endMs - beat.time.startMs;
	const frame = Math.max(1, frameIntervalMs);
	if (duration < frame * SUSTAINED_FRAME_INTERVALS) return;
	const edge = Math.max(frame * 2, duration * EDGE_FRACTION);
	const hasStart = beat.evidence.some((e) => Number.isFinite(e.ptsMs) && e.ptsMs <= beat.time.startMs + edge);
	const hasEnd = beat.evidence.some((e) => Number.isFinite(e.ptsMs) && e.ptsMs >= beat.time.endMs - edge);
	if (!hasStart) {
		errors.push(
			`${label} is a sustained animated/loading state (motion local-animation) but cites no frame near its START edge (<= ${Math.round(beat.time.startMs + edge)}ms); densely inspect the state's start and cite the FIRST frame that shows it (role 'boundary' or 'before').`,
		);
	}
	if (!hasEnd) {
		errors.push(
			`${label} is a sustained animated/loading state (motion local-animation) but cites no frame near its END edge (>= ${Math.round(beat.time.endMs - edge)}ms); densely inspect the state's end and cite the LAST frame that still shows it (role 'boundary' or 'after'), not the adjacent loaded screen.`,
		);
	}
}

function checkBeats(
	result: AnalysisResultV1,
	registry: EvidenceRegistryView,
	frameIntervalMs: number,
	errors: string[],
): void {
	const { durationMs } = result.source;
	const seenIds = new Set<string>();

	result.beats.forEach((beat, i) => {
		if (seenIds.has(beat.id)) errors.push(`duplicate beat id ${beat.id}`);
		seenIds.add(beat.id);

		inBounds(`beats[${i}] (${beat.id}) startMs`, beat.time.startMs, durationMs, errors);
		inBounds(`beats[${i}] (${beat.id}) endMs`, beat.time.endMs, durationMs, errors);
		if (beat.time.startMs > beat.time.endMs) {
			errors.push(`beats[${i}] (${beat.id}) has startMs ${beat.time.startMs} after endMs ${beat.time.endMs}`);
		}
		if (beat.time.precisionMs < 0) {
			errors.push(`beats[${i}] (${beat.id}) has negative precisionMs ${beat.time.precisionMs}`);
		}
		if (beat.time.startMs === beat.time.endMs && beat.time.precisionMs <= 0) {
			errors.push(
				`beats[${i}] (${beat.id}) is a point-like transient (startMs === endMs) but precisionMs is ${beat.time.precisionMs}; a zero-duration fact is not allowed`,
			);
		}

		if (i > 0) {
			const prev = result.beats[i - 1]!;
			if (beat.time.startMs < prev.time.startMs) {
				errors.push(
					`beats[${i}] (${beat.id}) is out of order: startMs ${beat.time.startMs} < previous startMs ${prev.time.startMs}`,
				);
			} else if (beat.time.startMs < prev.time.endMs) {
				errors.push(
					`beats[${i}] (${beat.id}) overlaps the previous beat: startMs ${beat.time.startMs} < previous endMs ${prev.time.endMs}`,
				);
			}
		}

		checkCitations(`beats[${i}] (${beat.id})`, beat.evidence, registry, durationMs, errors);
		checkTransitionOrdering(`beats[${i}] (${beat.id})`, beat.evidence, errors);
		checkAnimatedEdgeEvidence(`beats[${i}] (${beat.id})`, beat, frameIntervalMs, errors);
	});
}

function checkCitations(
	label: string,
	evidence: AnalysisResultV1["beats"][number]["evidence"],
	registry: EvidenceRegistryView,
	durationMs: number,
	errors: string[],
): void {
	evidence.forEach((citation, j) => {
		inBounds(`${label} evidence[${j}] ptsMs`, citation.ptsMs, durationMs, errors);
		const resolved = registry.resolve(citation.frameId);
		if (!resolved) {
			errors.push(`${label} evidence[${j}] cites frame ${citation.frameId} which is not in the evidence registry`);
			return;
		}
		if (resolved.ptsMs !== citation.ptsMs) {
			errors.push(
				`${label} evidence[${j}] ptsMs ${citation.ptsMs} does not match the registry PTS ${resolved.ptsMs} for ${citation.frameId}`,
			);
		}
	});
}

function checkTransitionOrdering(
	label: string,
	evidence: AnalysisResultV1["beats"][number]["evidence"],
	errors: string[],
): void {
	const before = evidence.filter((e) => e.role === "before");
	const after = evidence.filter((e) => e.role === "after");
	if (before.length === 0 || after.length === 0) return;
	const latestBefore = Math.max(...before.map((e) => e.ptsMs));
	const earliestAfter = Math.min(...after.map((e) => e.ptsMs));
	if (latestBefore > earliestAfter) {
		errors.push(
			`${label} transition evidence is mis-ordered: a 'before' frame at ${latestBefore}ms follows an 'after' frame at ${earliestAfter}ms`,
		);
	}
}

function checkAnomalies(result: AnalysisResultV1, registry: EvidenceRegistryView, errors: string[]): void {
	const { durationMs } = result.source;
	const beatIds = new Set(result.beats.map((b) => b.id));

	result.anomalies.forEach((anomaly, i) => {
		for (const beatId of anomaly.beatIds) {
			if (!beatIds.has(beatId)) {
				errors.push(`anomalies[${i}] references unknown beat id ${beatId}`);
			}
		}
		checkCitations(`anomalies[${i}]`, anomaly.evidence, registry, durationMs, errors);
	});
}

function dedupe(errors: string[]): string[] {
	return [...new Set(errors)];
}
