/**
 * Production AUTO-COVERAGE allowances (supersedes the frozen evaluation caps).
 *
 * The historical 12/250/12 analyst + reviewer-half budgets were tuned for a frozen
 * evaluation, not for arbitrary user videos. A long/busy recording (e.g. 4:18 with
 * 179 candidate windows) can legitimately need far more than a dozen inspect_range
 * calls just to cover every mandatory window PLUS every >=5s chronology gap PLUS
 * boundary/loading refinement — so the old caps forced an honest-but-useless
 * `partial` even though provider usage and cells remained.
 *
 * This module derives GENEROUS, deterministic per-video allowances from engine
 * complexity (duration and isolated-transient obligations; remaining source facts
 * are validated for integrity). The count ledgers
 * remain as runaway guards and usage telemetry, but are sized so the deterministic
 * obligations can always be completed. The plan GROUP count (how the recording is
 * split into targetable mandatory windows) is deliberately DECOUPLED from the high
 * ceiling: a high allowance does not turn 179 candidates into 179 mandatory sheets.
 *
 * The historical frozen budgets remain available via `frozenAllowancePlan` for
 * evaluation reproducibility (opt-in through `VTD_FIXED_BUDGETS=1` in the flows).
 * Everything here is a pure function of its input and unit-testable without a model.
 */
import { DEFAULT_BUDGETS, type InspectionBudgets, REVIEWER_BUDGETS } from "../evidence/budgets.ts";
import { computeMandatoryMaxGroups, computeMandatoryMaxWindowMs } from "./analysis-common.ts";

/** Deterministic complexity signals taken from the evidence engine. */
export interface CoverageComplexity {
	durationMs: number;
	averageFps: number;
	frameCount: number;
	candidateCount: number;
	isolatedTransientCount: number;
}

/** One role's (analyst or reviewer) allowance plus the deterministic plan sizing. */
export interface RoleAllowance {
	budgets: InspectionBudgets;
	/** Upper bound on mandatory windows the recording is split into (plan quality). */
	mandatoryGroups: number;
	/** Target maximum mandatory-window width (ms). */
	mandatoryMaxWindowMs: number;
	/** Isolated-transient focus windows to reserve (auto-sized to the detected count). */
	isolatedMaxWindows: number;
	/** Isolated-transient peak full-resolution reads to reserve (>= detected count). */
	isolatedMaxPeaks: number;
	/** Estimated worst-case selected frames/cells (for the busy-video warning). */
	estimatedMaxCells: number;
	/** Estimated worst-case images (sheets + full-res frames) sent to the provider. */
	estimatedMaxImages: number;
}

export interface AllowancePlan {
	analyst: RoleAllowance;
	reviewer: RoleAllowance;
	/** Worst-case number of disjoint >=5s chronology gaps in the recording. */
	maxChronologyGaps: number;
	/** True for the auto plan, false for the frozen-evaluation plan. */
	auto: boolean;
}

// --- Sizing constants (production auto-scaling) -----------------------------
/** A >=5s uninspected span is a "large gap" (mirrors the inspection-context default). */
const LARGE_GAP_MS = 5000;
/** Per-call sample cap (mirrors the inspection-context default) for cell estimates. */
const MAX_RANGE_SAMPLES = 24;
/** Base overview cells; isolated protected peaks are added beyond this selector cap. */
const OVERVIEW_CELLS = 48;
/** Aim for roughly one targetable mandatory window per this many ms. */
const TARGET_WINDOW_MS = 12000;
/** Never plan fewer than this many groups (historical minimum). */
const MIN_GROUPS = 10;
/** Slack applied to the cell ceiling so cells never bind before ranges. */
const CELLS_SLACK = 1.1;

function assertComplexity(c: CoverageComplexity): void {
	const integers: Array<[string, number, boolean]> = [
		["durationMs", c.durationMs, false],
		["frameCount", c.frameCount, true],
		["candidateCount", c.candidateCount, true],
		["isolatedTransientCount", c.isolatedTransientCount, true],
	];
	for (const [name, value, allowZero] of integers) {
		if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
			throw new RangeError(
				`Invalid coverage complexity: ${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer.`,
			);
		}
	}
	if (!Number.isFinite(c.averageFps) || c.averageFps <= 0) {
		throw new RangeError("Invalid coverage complexity: averageFps must be a positive finite number.");
	}
}

function safeDerived(name: string, value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`Derived allowance ${name} must be a non-negative safe integer.`);
	}
	return value;
}

/** A long or busy recording where the model may send materially more images. */
export function isLongOrBusy(c: CoverageComplexity): boolean {
	return c.durationMs >= 120_000 || c.candidateCount >= 100 || c.isolatedTransientCount > 0;
}

function estimatedMaxCells(budgets: InspectionBudgets): number {
	return budgets.cells;
}
function estimatedMaxImages(budgets: InspectionBudgets): number {
	return safeDerived(
		"estimatedMaxImages",
		budgets.rangeInspections + budgets.overviewInspections + budgets.fullResolutionFrames,
	);
}

function roleAllowance(
	budgets: InspectionBudgets,
	sizing: {
		mandatoryGroups: number;
		mandatoryMaxWindowMs: number;
		isolatedMaxWindows: number;
		isolatedMaxPeaks: number;
	},
): RoleAllowance {
	return {
		budgets,
		...sizing,
		estimatedMaxCells: estimatedMaxCells(budgets),
		estimatedMaxImages: estimatedMaxImages(budgets),
	};
}

/**
 * Generous deterministic per-video allowances. Analyst and reviewer SHARE the same
 * mandatory-window plan (so both can cover the same windows and the reviewer can
 * close analyst gaps), but each has its own independent count ledger sized to
 * complete all obligations with refinement headroom.
 */
export function computeAllowancePlan(c: CoverageComplexity): AllowancePlan {
	assertComplexity(c);
	const durationMs = c.durationMs;
	const maxChronologyGaps = safeDerived("maxChronologyGaps", Math.ceil(durationMs / LARGE_GAP_MS));
	// No fixed production cap: the plan continues scaling at roughly one targetable
	// group per 12 seconds, however long the finite source is.
	const groups = safeDerived("mandatoryGroups", Math.max(MIN_GROUPS, Math.round(durationMs / TARGET_WINDOW_MS)));
	const mandatoryMaxWindowMs = safeDerived("mandatoryMaxWindowMs", Math.max(6000, Math.ceil(durationMs / groups)));
	const isolatedMaxWindows = safeDerived("isolatedMaxWindows", Math.max(4, c.isolatedTransientCount));
	const isolatedMaxPeaks = safeDerived("isolatedMaxPeaks", Math.max(8, c.isolatedTransientCount));

	// Baseline calls for span groups, isolated focus, and every possible chronology
	// gap. The separate refinement headroom (minimum 12/6) also covers the context's
	// at-most-three transient-focus windows before any boundary/loading refinement.
	const coverageRanges = safeDerived("coverageRanges", groups + isolatedMaxWindows + maxChronologyGaps);

	const analystBudgets = sizeBudgets({
		coverageRanges,
		groups,
		isolatedMaxPeaks,
		minBudgets: DEFAULT_BUDGETS,
		rangeRefinement: Math.max(12, Math.round(groups * 0.75)),
		fullResRefinement: Math.max(12, groups),
		overview: 8,
		comparisons: Math.max(8, groups),
		minCells: DEFAULT_BUDGETS.cells,
		overviewCellsPerInspection: OVERVIEW_CELLS + c.isolatedTransientCount,
	});
	const reviewerBudgets = sizeBudgets({
		coverageRanges,
		groups,
		isolatedMaxPeaks,
		minBudgets: REVIEWER_BUDGETS,
		rangeRefinement: Math.max(6, Math.round(groups * 0.35)),
		fullResRefinement: Math.max(6, Math.round(groups * 0.5)),
		overview: 4,
		comparisons: Math.max(4, Math.round(groups / 2)),
		minCells: REVIEWER_BUDGETS.cells,
		overviewCellsPerInspection: OVERVIEW_CELLS + c.isolatedTransientCount,
	});

	const sizing = { mandatoryGroups: groups, mandatoryMaxWindowMs, isolatedMaxWindows, isolatedMaxPeaks };
	return {
		analyst: roleAllowance(analystBudgets, sizing),
		reviewer: roleAllowance(reviewerBudgets, sizing),
		maxChronologyGaps,
		auto: true,
	};
}

function sizeBudgets(input: {
	coverageRanges: number;
	groups: number;
	isolatedMaxPeaks: number;
	minBudgets: InspectionBudgets;
	rangeRefinement: number;
	fullResRefinement: number;
	overview: number;
	comparisons: number;
	minCells: number;
	overviewCellsPerInspection: number;
}): InspectionBudgets {
	// These are finite per-video ledgers, not fixed global production clamps. Every
	// ceiling is derived from this recording's complete deterministic obligation plus
	// refinement headroom; impossible arithmetic fails explicitly rather than silently
	// under-sizing coverage.
	const rangeInspections = safeDerived(
		"rangeInspections",
		Math.max(input.minBudgets.rangeInspections, input.coverageRanges + input.rangeRefinement),
	);
	const overviewInspections = safeDerived(
		"overviewInspections",
		Math.max(input.minBudgets.overviewInspections, input.overview),
	);
	const fullResolutionFrames = safeDerived(
		"fullResolutionFrames",
		Math.max(input.minBudgets.fullResolutionFrames, input.isolatedMaxPeaks + input.fullResRefinement),
	);
	const comparisons = safeDerived("comparisons", Math.max(input.minBudgets.comparisons, input.comparisons));
	const cells = safeDerived(
		"cells",
		Math.max(
			input.minCells,
			Math.ceil(
				(rangeInspections * MAX_RANGE_SAMPLES + overviewInspections * input.overviewCellsPerInspection) * CELLS_SLACK,
			),
		),
	);
	return {
		rangeInspections,
		overviewInspections,
		cells,
		fullResolutionFrames,
		comparisons,
		sheetMaxDimension: input.minBudgets.sheetMaxDimension,
		sheetMaxBytes: input.minBudgets.sheetMaxBytes,
	};
}

/**
 * The FROZEN evaluation plan: the historical 12/250/12 analyst + reviewer-half
 * budgets and the original per-role group math, kept for reproducibility of the
 * committed evaluation. Selected only when `VTD_FIXED_BUDGETS=1` is set.
 */
export function frozenAllowancePlan(durationMs: number): AllowancePlan {
	const maxChronologyGaps = Math.ceil(Math.max(1, durationMs) / LARGE_GAP_MS);
	const analyst = roleAllowance(DEFAULT_BUDGETS, {
		mandatoryGroups: computeMandatoryMaxGroups(DEFAULT_BUDGETS.rangeInspections),
		mandatoryMaxWindowMs: computeMandatoryMaxWindowMs(durationMs, DEFAULT_BUDGETS.rangeInspections),
		isolatedMaxWindows: 4,
		isolatedMaxPeaks: 8,
	});
	const reviewer = roleAllowance(REVIEWER_BUDGETS, {
		mandatoryGroups: computeMandatoryMaxGroups(REVIEWER_BUDGETS.rangeInspections),
		mandatoryMaxWindowMs: computeMandatoryMaxWindowMs(durationMs, REVIEWER_BUDGETS.rangeInspections),
		isolatedMaxWindows: 4,
		isolatedMaxPeaks: 8,
	});
	return { analyst, reviewer, maxChronologyGaps, auto: false };
}
