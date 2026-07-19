/**
 * M3 inspection context: the constrained evidence layer the analyst/reviewer
 * tools call (implementation plan §7–8).
 *
 * It is built once from a deterministic `EvidenceEngineResult` and owns every
 * side effect the inspection tools need — exact frame extraction, evidence
 * registration, contact-sheet rendering, full-resolution frame loading, and
 * deterministic comparison — while enforcing budgets and the duplicate/refinement rule
 * inside each operation. The tools themselves are thin adapters over the methods
 * here, so all authorization and budget behavior is testable without a model.
 *
 * No method accepts an arbitrary path: every frame is reached only through a
 * registered evidence ID or a resolved source ordinal. This is the trust boundary
 * that keeps the agent incapable of arbitrary filesystem reads.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoadedFrameImage } from "../agent/tools/image-frame-tool.ts";
import type { EvidenceEngineResult } from "../app/evidence-engine.ts";
import type { FfmpegCallOptions } from "../video/ffmpeg.ts";
import { BudgetLedger, type BudgetUsage, DEFAULT_BUDGETS, type InspectionBudgets } from "./budgets.ts";
import { type ComparisonResult, compareEvidence } from "./compare.ts";
import { type ContactSheetManifestEntry, type ContactSheetOptions, renderContactSheet } from "./contact-sheet.ts";
import {
	type TimeSpan,
	isFrameSpanCovered,
	mergeRangesWithTolerance,
	uncoveredFrameSubsegments,
} from "./coverage-geometry.ts";
import { extractEvidenceFrames } from "./extract-evidence.ts";
import {
	type MandatoryWindow,
	clusterIsolatedFocusWindows,
	clusterTransientWindows,
	groupMandatoryWindows,
} from "./mandatory-windows.ts";
import { type OverviewSelectionOptions, selectOverviewOrdinals } from "./overview.ts";
import { resolveRangeOrdinals } from "./range.ts";
import { EvidenceRegistry, type InspectionReason, rangeDensity } from "./registry.ts";

export class FrameAuthorizationError extends Error {
	constructor(id: string) {
		super(`Frame ID ${JSON.stringify(id)} is not in the evidence registry; only registered frames are accessible.`);
		this.name = "FrameAuthorizationError";
	}
}

export type ToolRejection = { ok: false; message: string };

export interface SheetImage {
	data: string;
	mimeType: "image/png";
	width: number;
	height: number;
}

export interface CandidateSummaryEntry {
	kind: string;
	startMs: number;
	endMs: number;
	score: number;
	representativeOrdinal: number;
}

export interface OverviewOutput {
	ok: true;
	sheet: SheetImage;
	manifest: ContactSheetManifestEntry[];
	candidateSummary: CandidateSummaryEntry[];
}

export interface RangeRequest {
	startMs: number;
	endMs: number;
	samples: number;
	reason: InspectionReason;
}

export interface RangeOutput {
	ok: true;
	sheet: SheetImage;
	manifest: ContactSheetManifestEntry[];
	resolvedStartMs: number;
	resolvedEndMs: number;
	reason: InspectionReason;
	samples: number;
}

/** A grouped mandatory window plus whether a targeted range has covered it yet. */
export interface MandatoryWindowStatus extends MandatoryWindow {
	uninspected: boolean;
	/**
	 * The CANONICAL uncovered sub-parts of this window given the frame-interval
	 * tolerant union of the targeted ranges. Empty when the window is covered; a
	 * partially-inspected window reports only the genuine gaps wider than one frame,
	 * never sampled sub-frame slivers. `uninspected === uncoveredSubsegments.length > 0`.
	 */
	uncoveredSubsegments: TimeSpan[];
	/**
	 * For an isolated-transient focus window: the peak frame IDs (once registered)
	 * the agent must read at full resolution, and which of those still need a read.
	 */
	peakFrameIds?: string[];
	peakOrdinalsNeedingFullRes?: number[];
}

export interface InspectionStatus {
	budgets: BudgetUsage;
	registeredFrames: number;
	inspectedRanges: Array<{
		startMs: number;
		endMs: number;
		reason: InspectionReason;
		samples: number;
		/** Samples per second across the range (coverage density). */
		density: number;
	}>;
	uninspectedCandidates: CandidateSummaryEntry[];
	/**
	 * Candidate windows reconciled with the range budget into a bounded, honest set
	 * of must-inspect windows. `complete` coverage requires every one covered.
	 */
	mandatoryWindows: MandatoryWindowStatus[];
	largeGaps: Array<{ startMs: number; endMs: number }>;
	/**
	 * Isolated transients that could not be given a mandatory focus within budget
	 * (deterministically ranked/capped). They are surfaced as genuinely uncovered so a
	 * submission must be an HONEST partial listing them, never a silent "complete".
	 */
	unsatisfiedIsolatedTransients?: TimeSpan[];
}

export interface InspectionContextOptions {
	videoPath: string;
	/** Private workspace directory that holds extracted frames and sheets. */
	workspaceDir: string;
	budgets?: InspectionBudgets;
	overview?: OverviewSelectionOptions;
	sheet?: ContactSheetOptions;
	/** Upper bound on `inspect_range` samples per call (default 24). */
	maxRangeSamples?: number;
	/** Uninspected temporal gaps at least this many ms are "large" (default 5000). */
	largeGapMs?: number;
	/** Candidate windows within this many ms are grouped into one mandatory window (default 1000). */
	mandatoryMergeGapMs?: number;
	/**
	 * Upper bound on the number of mandatory windows. Defaults to the range budget,
	 * but the flows set it BELOW the range budget to reserve inspect_range calls for
	 * boundary/transient refinement, so covering every window once does not consume
	 * the entire budget.
	 */
	mandatoryMaxGroups?: number;
	/**
	 * Frame-interval coverage tolerance in ms. Adjacent targeted ranges whose PTS
	 * gap is at most this merge into one covered span, and uncovered slivers at or
	 * below this are never flagged. Defaults to one frame interval from the source
	 * average fps.
	 */
	coverageToleranceMs?: number;
	/**
	 * Maximum targetable mandatory-window width. A busy recording whose candidates
	 * chain together is split at its largest internal gaps into balanced windows no
	 * wider than this, instead of collapsing into one whole-video window. When
	 * omitted, no width-based splitting occurs.
	 */
	mandatoryMaxWindowMs?: number;
	/** Max isolated-transient focus windows (mandatory groups) to reserve (default 4). */
	isolatedMaxWindows?: number;
	/** Max isolated-transient peak frames to require full-res reads for (default 8). */
	isolatedMaxPeaks?: number;
	/**
	 * A pre-existing evidence registry to reuse. The reviewer shares the analyst's
	 * deterministic registry/files (so it can cite already-extracted frames) while
	 * keeping its OWN independent budget ledger. When omitted, a fresh registry is
	 * created.
	 */
	registry?: EvidenceRegistry;
	ffmpeg?: FfmpegCallOptions;
}

const DEFAULT_MAX_RANGE_SAMPLES = 24;
const DEFAULT_LARGE_GAP_MS = 5000;
const DEFAULT_MANDATORY_MERGE_GAP_MS = 1000;
/** How many of the strongest transient clusters become density-gated focus windows. */
const TRANSIENT_FOCUS_COUNT = 3;
/** Minimum samples/sec that counts as densely inspecting a transient focus window. */
const TRANSIENT_MIN_DENSITY = 6;
/** Default cap on isolated-transient focus windows (mandatory groups) reserved. */
const ISOLATED_MAX_WINDOWS = 4;
/** Default cap on isolated-transient peak frames requiring a full-resolution read. */
const ISOLATED_MAX_PEAKS = 8;
/**
 * Isolated transients within this gap share ONE focus window (each peak still
 * requires its own full-resolution read). Wider than the span merge gap so a burst
 * of nearby brief flashes becomes one targetable focus rather than many groups.
 */
const ISOLATED_MERGE_GAP_MS = 2000;

export interface InspectionContext {
	readonly registry: EvidenceRegistry;
	readonly budgets: BudgetLedger;
	readonly maxRangeSamples: number;
	/** The reconciled, budget-bounded must-inspect windows (invariant across the run). */
	readonly mandatoryWindows: readonly MandatoryWindow[];
	/**
	 * Narrow clusters of brief TRANSIENT candidates (sub-second bursts such as a
	 * momentary error/`Waiting`/`cleared` flash). They are surfaced separately so the
	 * analyst can inspect each at HIGH DENSITY — a wide mandatory window sampled
	 * sparsely would step over them. Invariant across the run.
	 */
	readonly transientWindows: readonly MandatoryWindow[];
	/**
	 * Rare ISOLATED-transient focus windows: each must be densely inspected AND have
	 * every peak frame read at full resolution before `complete`. Invariant across
	 * the run.
	 */
	readonly isolatedFocusWindows: readonly MandatoryWindow[];
	runOverview(): Promise<OverviewOutput | ToolRejection>;
	runRange(input: RangeRequest): Promise<RangeOutput | ToolRejection>;
	loadFrame(frameId: string): Promise<LoadedFrameImage>;
	runCompare(frameIds: readonly string[]): Promise<ComparisonResult | ToolRejection>;
	status(): InspectionStatus;
}

function candidateSummary(result: EvidenceEngineResult, limit = 40): CandidateSummaryEntry[] {
	return result.candidates.slice(0, limit).map((candidate) => ({
		kind: candidate.kind,
		startMs: Math.round(candidate.startPtsUs / 1000),
		endMs: Math.round(candidate.endPtsUs / 1000),
		score: candidate.score,
		representativeOrdinal: candidate.representativeOrdinal,
	}));
}

/** Merge inspected ranges and return uninspected gaps of at least `minGapMs`. */
function computeLargeGaps(
	ranges: ReadonlyArray<{ startMs: number; endMs: number }>,
	durationMs: number,
	minGapMs: number,
): Array<{ startMs: number; endMs: number }> {
	const merged = [...ranges].sort((a, b) => a.startMs - b.startMs);
	const gaps: Array<{ startMs: number; endMs: number }> = [];
	let cursor = 0;
	for (const range of merged) {
		if (range.startMs - cursor >= minGapMs) gaps.push({ startMs: cursor, endMs: range.startMs });
		cursor = Math.max(cursor, range.endMs);
	}
	if (durationMs - cursor >= minGapMs) gaps.push({ startMs: cursor, endMs: durationMs });
	return gaps;
}

export function createInspectionContext(
	result: EvidenceEngineResult,
	options: InspectionContextOptions,
): InspectionContext {
	const registry = options.registry ?? new EvidenceRegistry();
	const budgets = new BudgetLedger(options.budgets ?? DEFAULT_BUDGETS);
	const maxRangeSamples = options.maxRangeSamples ?? DEFAULT_MAX_RANGE_SAMPLES;
	const largeGapMs = options.largeGapMs ?? DEFAULT_LARGE_GAP_MS;
	const durationMs = result.source.durationMs;
	// One frame interval: adjacent targeted ranges within this merge, and slivers at
	// or below this are never labelled uninspected (see coverage-geometry).
	const coverageToleranceMs =
		options.coverageToleranceMs ?? Math.max(1, Math.ceil(1000 / Math.max(result.source.averageFps, 1)));
	// Sorted source-frame PTS (ms) for FRAME-AWARE coverage: a window is covered when
	// every source frame in it has been seen, so multi-second VFR gaps between two
	// consecutive frames never read as uninspected (see coverage-geometry).
	const framePtsMs = result.catalog.frames.map((f) => Math.round(f.ptsUs / 1000)).sort((a, b) => a - b);
	// Narrow transient-candidate clusters, surfaced so the analyst densely inspects
	// each brief burst instead of stepping over it inside a wide window.
	const transientWindows = clusterTransientWindows(
		result.candidates
			.filter((candidate) => candidate.kind === "transient")
			.map((candidate) => ({
				startMs: Math.round(candidate.startPtsUs / 1000),
				endMs: Math.round(candidate.endPtsUs / 1000),
				kind: candidate.kind,
			})),
		{ mergeGapMs: options.mandatoryMergeGapMs ?? DEFAULT_MANDATORY_MERGE_GAP_MS, maxWidthMs: 3000, maxCount: 12 },
	);
	// The strongest transient clusters become DENSITY-GATED focus windows: they must
	// be inspected at high density to count as covered, so a sparse pass over a wide
	// span cannot silently swallow a sub-second burst (e.g. a momentary
	// 'Waiting'/'cleared' state). Kept few so they fit alongside the span windows.
	const focusCount = Math.min(TRANSIENT_FOCUS_COUNT, transientWindows.length);
	const focusWindows: MandatoryWindow[] = [...transientWindows]
		.sort((a, b) => b.candidateCount - a.candidateCount || a.endMs - a.startMs - (b.endMs - b.startMs))
		.slice(0, focusCount)
		.map((w) => ({ ...w, minDensity: TRANSIENT_MIN_DENSITY }))
		.sort((a, b) => a.startMs - b.startMs);
	// Rare ISOLATED transients get their OWN mandatory focus, independent of the
	// popularity/score ranking that drives the span/transient windows. Each carries
	// its peak ordinal(s), which must be read at full resolution (see status). Kept
	// deterministically to a small budget; whatever does not fit overflows to an
	// honest partial rather than being silently marked inspected.
	const { windows: isolatedFocusWindows, overflow: isolatedOverflow } = clusterIsolatedFocusWindows(
		(result.isolatedTransients ?? []).map((t) => ({
			startMs: Math.round(t.startPtsUs / 1000),
			endMs: Math.round(t.endPtsUs / 1000),
			peakOrdinal: t.peakOrdinal,
			peakRatio: t.peakRatio,
		})),
		{
			mergeGapMs: ISOLATED_MERGE_GAP_MS,
			minDensity: TRANSIENT_MIN_DENSITY,
			maxWindows: options.isolatedMaxWindows ?? ISOLATED_MAX_WINDOWS,
			maxPeaks: options.isolatedMaxPeaks ?? ISOLATED_MAX_PEAKS,
		},
	);
	// Peak frames of the kept isolated focus windows must be registered so the agent
	// can `inspect_frame` them; they are protected into the overview selection.
	const isolatedPeakOrdinals = isolatedFocusWindows.flatMap((w) => w.peakOrdinals ?? []);
	const unsatisfiedIsolatedTransients: TimeSpan[] = isolatedOverflow.map((o) => ({
		startMs: o.startMs,
		endMs: Math.max(o.endMs, o.startMs + 1),
	}));
	// Reconcile the (possibly many) candidate windows with the range budget so that
	// `complete` coverage is achievable within budget rather than forcing the agent
	// to mark the overview as coverage or silently drop candidates. The span-window
	// cap leaves room for the density-gated transient AND isolated focus windows.
	const requestedMaxGroups = options.mandatoryMaxGroups ?? budgets.budgets.rangeInspections;
	const spanWindows = groupMandatoryWindows(
		result.candidates.map((candidate) => ({
			startMs: Math.round(candidate.startPtsUs / 1000),
			endMs: Math.round(candidate.endPtsUs / 1000),
			kind: candidate.kind,
		})),
		{
			maxGroups: Math.max(1, requestedMaxGroups - focusCount - isolatedFocusWindows.length),
			mergeGapMs: options.mandatoryMergeGapMs ?? DEFAULT_MANDATORY_MERGE_GAP_MS,
			...(options.mandatoryMaxWindowMs !== undefined ? { maxWindowMs: options.mandatoryMaxWindowMs } : {}),
		},
	);
	// Combined must-inspect set: span windows (span coverage) plus density-gated
	// transient and isolated focus windows (which may nest inside a span window).
	const mandatoryWindows: MandatoryWindow[] = [...spanWindows, ...focusWindows, ...isolatedFocusWindows].sort(
		(a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
	);
	const ffmpeg = options.ffmpeg ?? {};
	let inspectionSeq = 0;

	async function extractCells(ordinals: number[], label: string) {
		const outDir = join(options.workspaceDir, `${label}-${++inspectionSeq}`);
		const records = await extractEvidenceFrames(options.videoPath, ordinals, result.catalog, outDir, ffmpeg);
		registry.register(records);
		return records;
	}

	async function renderSheet(records: Awaited<ReturnType<typeof extractCells>>) {
		const sheet = await renderContactSheet(
			records.map((r) => ({ frameId: r.id, ptsMs: r.ptsMs, imagePath: r.path, width: r.width, height: r.height })),
			{ maxDimension: budgets.budgets.sheetMaxDimension, maxBytes: budgets.budgets.sheetMaxBytes, ...options.sheet },
		);
		const image: SheetImage = {
			data: sheet.png.toString("base64"),
			mimeType: "image/png",
			width: sheet.width,
			height: sheet.height,
		};
		return { image, manifest: sheet.manifest };
	}

	return {
		registry,
		budgets,
		maxRangeSamples,
		mandatoryWindows,
		transientWindows,
		isolatedFocusWindows,

		async runOverview(): Promise<OverviewOutput | ToolRejection> {
			const ordinals = selectOverviewOrdinals(
				{
					frameCount: result.catalog.frames.length,
					candidates: result.candidates,
					...(isolatedPeakOrdinals.length > 0 ? { protectedOrdinals: isolatedPeakOrdinals } : {}),
				},
				options.overview ?? {},
			);
			if (ordinals.length === 0) return { ok: false, message: "The source has no frames to build an overview from." };
			// `consume` is the authoritative atomic budget gate: it checks and decrements
			// in one step, and its return — not a prior `canAfford` — decides admission.
			// Exact extraction yields exactly one record per requested ordinal, so
			// reserving `ordinals.length` cells here matches what is rendered.
			const gate = budgets.consume({ overviewInspections: 1, cells: ordinals.length });
			if (!gate.ok) return gate;

			const records = await extractCells(ordinals, "overview");
			const { image, manifest } = await renderSheet(records);
			registry.recordInspectedRange({
				startMs: 0,
				endMs: durationMs,
				reason: "overview",
				density: rangeDensity(0, durationMs, records.length),
				samples: records.length,
			});
			return { ok: true, sheet: image, manifest, candidateSummary: candidateSummary(result) };
		},

		async runRange(input: RangeRequest): Promise<RangeOutput | ToolRejection> {
			// Reject a zero-width (point) request BEFORE consuming budget: a single point
			// covers no span, so it wastes an inspect_range call and never clears a window.
			// Redirect the agent to a real span (or inspect_frame for one frame).
			if (input.endMs <= input.startMs) {
				return {
					ok: false,
					message: `inspect_range needs endMs > startMs; a zero-width range (${input.startMs}-${input.endMs}ms) covers nothing and is not spent. To cover a still-uncovered A-B sub-part, call inspect_range with startMs=A, endMs=B and samples>=4. For a single frame, use inspect_frame.`,
				};
			}
			const samples = Math.max(1, Math.min(maxRangeSamples, Math.floor(input.samples)));
			const { ordinals, resolvedStartMs, resolvedEndMs } = resolveRangeOrdinals(
				result.catalog,
				input.startMs,
				input.endMs,
				samples,
			);
			if (ordinals.length === 0) {
				return { ok: false, message: "No source frames fall in or near the requested range." };
			}

			const density = rangeDensity(resolvedStartMs, resolvedEndMs, ordinals.length);
			const admission = registry.admitRange(resolvedStartMs, resolvedEndMs, input.reason, density);
			if (!admission.ok) return admission;

			// Authoritative atomic budget gate (see runOverview): honor consume's return.
			const gate = budgets.consume({ rangeInspections: 1, cells: ordinals.length });
			if (!gate.ok) return gate;

			const records = await extractCells(ordinals, "range");
			const { image, manifest } = await renderSheet(records);
			registry.recordInspectedRange({
				startMs: resolvedStartMs,
				endMs: resolvedEndMs,
				reason: input.reason,
				density,
				samples: records.length,
			});
			return {
				ok: true,
				sheet: image,
				manifest,
				resolvedStartMs,
				resolvedEndMs,
				reason: input.reason,
				samples: records.length,
			};
		},

		async loadFrame(frameId: string): Promise<LoadedFrameImage> {
			const record = registry.get(frameId);
			if (!record) throw new FrameAuthorizationError(frameId);
			const affordable = budgets.consume({ fullResolutionFrames: 1 });
			if (!affordable.ok) throw new Error(affordable.message);
			// Record the full-resolution read by source ordinal (shared with a reviewer that
			// reuses this registry) so an isolated-transient peak read here clears its gate.
			registry.markFullResRead(record.ordinal);
			const bytes = await readFile(record.path);
			return { data: bytes.toString("base64"), mimeType: "image/png", width: record.width, height: record.height };
		},

		async runCompare(frameIds: readonly string[]): Promise<ComparisonResult | ToolRejection> {
			if (frameIds.length < 2) return { ok: false, message: "compare_evidence requires at least two frame IDs." };
			const inputs = [];
			for (const id of frameIds) {
				const record = registry.get(id);
				if (!record) return { ok: false, message: `Frame ID ${JSON.stringify(id)} is not registered; cannot compare.` };
				inputs.push({ id, imagePath: record.path });
			}
			const affordable = budgets.consume({ comparisons: 1 });
			if (!affordable.ok) return affordable;
			return compareEvidence(inputs);
		},

		status(): InspectionStatus {
			const inspected = registry.inspectedRanges();
			const inspectedRanges = inspected.map((r) => ({
				startMs: r.startMs,
				endMs: r.endMs,
				reason: r.reason,
				samples: r.samples,
				density: r.density,
			}));
			// Coverage is reason/density aware. The overview is a sparse, full-span
			// sampling pass (low density spanning 0..duration), NOT dense inspection, so
			// it must never mark a mandatory candidate window or a large temporal gap as
			// covered. Only targeted inspect_range calls count as coverage, so after an
			// overview the mandatory candidates and large gaps remain until a targeted
			// range actually inspects them.
			//
			// Coverage is union-based: a window is covered when the merged span of the
			// targeted ranges contiguously contains it. A single containing range is the
			// special case, but several adjacent ranges may also cover a wide grouped
			// mandatory window — so the agent can honestly reach `complete` within the
			// range budget instead of needing one impossibly wide range.
			// FRAME-AWARE union: adjacent targeted ranges are merged (sub-frame tolerance),
			// then a window is covered when every SOURCE FRAME in it falls within an
			// inspected range. A multi-second static VFR gap between two consecutive frames
			// is therefore covered once both are seen, and no sampled sliver is flagged.
			const targeted = inspected.filter((r) => r.reason !== "overview");
			const mergedTargeted = mergeRangesWithTolerance(targeted, coverageToleranceMs);
			const covered = (startMs: number, endMs: number): boolean =>
				isFrameSpanCovered(startMs, endMs, framePtsMs, mergedTargeted, coverageToleranceMs);
			const uninspectedCandidates = candidateSummary(result).filter((c) => !covered(c.startMs, c.endMs));
			// A density-gated window additionally needs some targeted range overlapping it
			// to meet its minDensity, so a sparse span pass cannot cover a sub-second burst.
			const meetsDensity = (w: MandatoryWindow): boolean =>
				w.minDensity === undefined ||
				targeted.some((r) => r.startMs <= w.endMs && r.endMs >= w.startMs && r.density >= w.minDensity!);
			const mandatoryStatus: MandatoryWindowStatus[] = mandatoryWindows.map((w) => {
				const frameUncovered = uncoveredFrameSubsegments(
					w.startMs,
					w.endMs,
					framePtsMs,
					mergedTargeted,
					coverageToleranceMs,
				);
				// Span-covered but not densely inspected -> the whole window still needs a
				// dense pass, so surface it as the remaining uncovered subsegment.
				const uncovered =
					frameUncovered.length === 0 && !meetsDensity(w) ? [{ startMs: w.startMs, endMs: w.endMs }] : frameUncovered;
				// FAIL CLOSED for an isolated-transient focus window: dense coverage alone is
				// NOT enough; EVERY peak frame must have had a full-resolution read. Surface the
				// still-unread peaks (and their registered IDs, if the overview registered them)
				// so the agent knows exactly which frame to inspect_frame.
				const peakOrdinalsNeedingFullRes = (w.peakOrdinals ?? []).filter((o) => !registry.hasFullResRead(o));
				const peakFrameIds = (w.peakOrdinals ?? [])
					.map((o) => registry.getByOrdinal(o)?.id)
					.filter((id): id is string => id !== undefined);
				const uninspected = uncovered.length > 0 || peakOrdinalsNeedingFullRes.length > 0;
				return {
					...w,
					uninspected,
					uncoveredSubsegments: uncovered,
					...(w.peakOrdinals ? { peakOrdinalsNeedingFullRes, peakFrameIds } : {}),
				};
			});
			return {
				budgets: budgets.usage(),
				registeredFrames: registry.size(),
				inspectedRanges,
				uninspectedCandidates,
				mandatoryWindows: mandatoryStatus,
				largeGaps: computeLargeGaps(targeted, durationMs, largeGapMs),
				unsatisfiedIsolatedTransients,
			};
		},
	};
}
