/**
 * Deterministic, privacy-safe human progress formatting for the inspection loop.
 *
 * Everything here is a pure function of DETERMINISTIC facts: safe bounded tool
 * metadata (range, enum reason, authorized frame id, frame count), structured details, exact
 * registered source PTS, and the live inspection ledger/status snapshot. It never
 * formats model reasoning, prompt text, frame pixels/visible text, draft payloads,
 * credentials, or arbitrary local paths — and it never invents a wall-clock
 * percentage (model/reviewer latency is unpredictable). Progress is expressed as
 * phase/checklist state and exact counters only.
 */
import type { CompareToolDetails } from "../agent/tools/compare-evidence-tool.ts";
import type { ImageFrameToolDetails } from "../agent/tools/image-frame-tool.ts";
import type { OverviewToolDetails } from "../agent/tools/inspect-overview-tool.ts";
import type { RangeToolDetails } from "../agent/tools/inspect-range-tool.ts";
import type { InspectionStatus } from "../evidence/inspection-context.ts";

/** Format a millisecond offset as a human `MM:SS.mmm` clock (exact, never rounded up). */
export function formatClock(ms: number): string {
	const clamped = Math.max(0, Math.round(ms));
	const totalSeconds = Math.floor(clamped / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const millis = clamped % 1000;
	return `${pad2(minutes)}:${pad2(seconds)}.${pad3(millis)}`;
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}
function pad3(n: number): string {
	return String(n).padStart(3, "0");
}

export interface CandidateKindCounts {
	boundary: number;
	stable: number;
	localAnimation: number;
	transient: number;
}

/** One-line deterministic candidate breakdown by kind plus the isolated-transient count. */
export function formatCandidateBreakdown(counts: CandidateKindCounts, isolatedCount: number): string {
	const base = `candidates by kind: ${counts.boundary} boundary, ${counts.stable} stable, ${counts.localAnimation} local-animation, ${counts.transient} transient`;
	if (isolatedCount <= 0) return base;
	const noun = isolatedCount === 1 ? "isolated transient" : "isolated transients";
	return `${base}; ${isolatedCount} ${noun}`;
}

export interface InspectionPlan {
	role: "analyst" | "reviewer";
	/** Total mandatory windows that must be covered before claiming "complete". */
	mandatoryWindows: number;
	/** Windows that need a dense pass (not the isolated-transient focus windows). */
	denseWindows: number;
	/** Isolated-transient focus windows (each also needs full-resolution peak reads). */
	isolatedWindows: number;
	/** Total full-resolution peak reads the isolated windows require. */
	isolatedPeaks: number;
	rangeInspections: number;
	cells: number;
	fullResolutionFrames: number;
}

/**
 * A compact plan summary emitted before each agent phase, so a human can see what
 * the phase must cover and its allowance. It states plainly that the overview is
 * navigation, not coverage, and that the reviewer runs on its own independent ledger.
 */
export function formatInspectionPlan(plan: InspectionPlan): string {
	const label = plan.role === "reviewer" ? "independent reviewer plan" : "analyst plan";
	const isolatedClause =
		plan.isolatedWindows > 0
			? `${plan.denseWindows} dense, ${plan.isolatedWindows} isolated / ${plan.isolatedPeaks} peak read(s)`
			: `${plan.denseWindows} dense, ${plan.isolatedWindows} isolated`;
	const parts = [
		`${label}: ${plan.mandatoryWindows} mandatory window(s) to cover (${isolatedClause})`,
		`allowance ${plan.rangeInspections} range · ${plan.cells} cells · ${plan.fullResolutionFrames} full-res`,
	];
	if (plan.role === "reviewer") parts.push("own independent ledger");
	parts.push("overview is navigation, not coverage");
	return parts.join("; ");
}

const OVERVIEW_PLAN_CELLS = 48;
const NOMINAL_RANGE_PLAN_CELLS = 12;

/** Estimate initial work from the ACTUAL context window count, including focus windows. */
export function estimateInitialPlan(
	mandatoryWindowCount: number,
	protectedOverviewCells = 0,
): {
	plannedInspections: number;
	plannedCellEstimate: number;
} {
	const windows = Math.max(0, Math.floor(mandatoryWindowCount));
	return {
		plannedInspections: 1 + windows,
		plannedCellEstimate:
			OVERVIEW_PLAN_CELLS + Math.max(0, Math.floor(protectedOverviewCells)) + windows * NOMINAL_RANGE_PLAN_CELLS,
	};
}

export interface AllowanceNotice {
	role: "analyst" | "reviewer";
	/** True for the auto-scaled plan, false for the frozen evaluation budgets. */
	auto: boolean;
	rangeInspections: number;
	cells: number;
	fullResolutionFrames: number;
	mandatoryWindows: number;
	isolatedPeaks: number;
	maxChronologyGaps: number;
	/** Initial plan inspections (1 overview + mandatory windows), distinct from the ceiling. */
	plannedInspections: number;
	/** Initial plan cell estimate, distinct from the worst-case `cells` ceiling. */
	plannedCellEstimate: number;
}

/**
 * The computed per-video allowance, logged before the phase. It draws a clear line
 * between three different numbers so the safety ceiling is never mistaken for work:
 *   - the CEILING (range/cells/full-res limits) is a worst-case runaway guard, NOT a
 *     batch that is automatically sent;
 *   - the INITIAL PLAN estimate (≈ inspections / cells) is what is typically
 *     processed before status-driven gap/refinement;
 *   - ACTUAL usage is reported per inspection as used/limit as it happens.
 */
export function formatAllowanceNotice(n: AllowanceNotice): string {
	const mode = n.auto ? "auto-scaled" : "frozen evaluation";
	return `${n.role} allowance (${mode}): ceiling ${n.rangeInspections} range · ${n.cells} cells · ${n.fullResolutionFrames} full-res (worst-case cap, not work sent); initial plan ~${n.plannedInspections} inspection(s) / ~${n.plannedCellEstimate} cells; ${n.mandatoryWindows} actual mandatory window(s) + up to ${n.maxChronologyGaps} gap close(s) + ${n.isolatedPeaks} isolated peak read(s)`;
}

/**
 * A long/busy-video warning: the WORST-CASE frames/images the model may request.
 * Actual usage is reported per inspection and is typically far lower; there is no
 * wall-clock percentage because model latency is unpredictable.
 */
export function formatBusyWarning(durationMs: number, estimatedMaxCells: number, estimatedMaxImages: number): string {
	return `long/busy recording (${formatClock(durationMs)}): the safety ceiling allows up to ~${estimatedMaxCells} frames across ~${estimatedMaxImages} images IF fully exhausted — this is a worst-case cap, not a batch sent up front. Frames cross to the model provider incrementally, only as contact sheets/full-res reads are requested; actual usage is reported per inspection and is typically far lower.`;
}

export interface RangeRequestInfo {
	startMs: number;
	endMs: number;
	samples: number;
	reason: string;
}

/**
 * A single completed (or rejected) inspection operation. `status` is the live
 * ledger snapshot taken immediately after the operation, so counters are exact.
 * A rejected request carries only its safe request shape (range/reason/count) and
 * the deterministic rejection message — never a payload dump.
 */
export type InspectionProgressEvent =
	| { tool: "inspect_overview"; details: OverviewToolDetails; status: InspectionStatus }
	| { tool: "inspect_range"; request: RangeRequestInfo; details: RangeToolDetails; status: InspectionStatus }
	| {
			tool: "inspect_frame";
			request: { frameId: string };
			ptsMs?: number;
			details: ImageFrameToolDetails;
			status: InspectionStatus;
	  }
	| {
			tool: "inspect_frame";
			rejection: "unregistered-frame-id" | "allowance-unavailable" | "inspection-unavailable";
			status: InspectionStatus;
	  }
	| { tool: "compare_evidence"; request: { frameIds: number }; details: CompareToolDetails; status: InspectionStatus }
	| { tool: "get_inspection_status"; status: InspectionStatus };

function used(status: InspectionStatus, category: keyof InspectionStatus["budgets"]): string {
	const u = status.budgets[category];
	return `${u.used}/${u.limit}`;
}

function coverage(status: InspectionStatus): string {
	const total = status.mandatoryWindows.length;
	const covered = status.mandatoryWindows.filter((w) => !w.uninspected).length;
	return `${covered}/${total}`;
}

function peakReadsRemaining(status: InspectionStatus): number {
	return status.mandatoryWindows.reduce((n, w) => n + (w.peakOrdinalsNeedingFullRes?.length ?? 0), 0);
}

/** Fixed artifact-retention notice; never echoes the user-supplied directory. */
export function formatArtifactsKeptProgress(): string {
	return "kept evidence and run manifest in the requested artifacts directory";
}

/** One compact, deterministic line per inspection operation. */
export function formatInspectionProgress(event: InspectionProgressEvent): string {
	switch (event.tool) {
		case "inspect_overview": {
			if (!event.details.accepted) return "overview rejected: inspection unavailable";
			return `overview: ${event.details.cells} cell(s) sampled; mandatory ${coverage(event.status)} covered; cells ${used(event.status, "cells")}; ${event.status.registeredFrames} frame(s) registered (navigation, not coverage)`;
		}
		case "inspect_range": {
			const { startMs, endMs, reason } = event.request;
			if (!event.details.accepted) {
				return `range ${formatClock(startMs)}–${formatClock(endMs)} (${reason}) rejected: request not admitted`;
			}
			const rStart = event.details.resolvedStartMs ?? startMs;
			const rEnd = event.details.resolvedEndMs ?? endMs;
			const gaps = event.status.largeGaps.length;
			return `range ${formatClock(rStart)}–${formatClock(rEnd)} (${reason}): ${event.details.samples} frame(s); mandatory ${coverage(event.status)} covered; range calls ${used(event.status, "rangeInspections")}; cells ${used(event.status, "cells")}; ${gaps} large gap(s) remain`;
		}
		case "inspect_frame": {
			if ("rejection" in event) {
				if (event.rejection === "unregistered-frame-id") return "frame request rejected: unregistered frame id";
				if (event.rejection === "allowance-unavailable") {
					return "frame request rejected: full-resolution allowance unavailable";
				}
				return "frame request rejected: inspection unavailable";
			}
			const timePart = event.ptsMs !== undefined ? ` @ ${formatClock(event.ptsMs)}` : "";
			const remaining = peakReadsRemaining(event.status);
			const peakPart = remaining > 0 ? `; ${remaining} peak read(s) remaining` : "";
			return `frame ${event.request.frameId}${timePart}: full-res ${used(event.status, "fullResolutionFrames")}${peakPart}`;
		}
		case "compare_evidence": {
			if (!event.details.accepted) {
				return `compare ${event.request.frameIds} frame(s) rejected: evidence unavailable`;
			}
			return `compare ${event.request.frameIds} frame(s): comparisons ${used(event.status, "comparisons")}`;
		}
		case "get_inspection_status": {
			const s = event.status;
			return `status: mandatory ${coverage(s)} covered; ${s.uninspectedCandidates.length} uninspected candidate(s); ${s.largeGaps.length} large gap(s); range ${used(s, "rangeInspections")}; cells ${used(s, "cells")}; full-res ${used(s, "fullResolutionFrames")}; compare ${used(s, "comparisons")}`;
		}
	}
}
