/**
 * `get_inspection_status` custom tool.
 *
 * Returns remaining budgets, already-inspected windows, uninspected candidate
 * windows, and large temporal gaps, so completeness is explicit before the agent
 * submits. It has no side effects and no path access.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { InspectionStatus } from "../../evidence/inspection-context.ts";
import type { CustomVideoTool } from "./tool-types.ts";

export interface StatusToolOptions {
	status(): InspectionStatus;
}

export interface StatusToolDetails {
	remainingRangeInspections: number;
	remainingCells: number;
	uninspectedCandidates: number;
	uninspectedMandatoryWindows: number;
	largeGaps: number;
}

const ParametersSchema = Type.Object({});

function render(status: InspectionStatus): string {
	const budgetLines = Object.entries(status.budgets).map(
		([category, u]) => `  ${category}: ${u.used}/${u.limit} used, ${u.remaining} remaining`,
	);
	const inspected = status.inspectedRanges.length
		? status.inspectedRanges.map(
				(r) => `  ${r.startMs}-${r.endMs}ms (${r.reason}, ${r.samples} frames, ${r.density.toFixed(2)} samples/s)`,
			)
		: ["  none"];
	const uninspected = status.uninspectedCandidates.length
		? status.uninspectedCandidates.map((c) => `  ${c.kind} ${c.startMs}-${c.endMs}ms (score ${c.score.toFixed(1)})`)
		: ["  none"];
	const mandatory = status.mandatoryWindows.length
		? status.mandatoryWindows.map((w) => {
				const dense = w.minDensity ? " [needs a DENSE pass: samples>=12 over this narrow span]" : "";
				const isolated = w.peakOrdinals
					? " [ISOLATED TRANSIENT: also inspect_frame each peak at full resolution and transcribe its literal on-screen text or mark it illegible]"
					: "";
				const base = `  ${w.startMs}-${w.endMs}ms [${w.kinds.join(",")}]${dense}${isolated} ${w.uninspected ? "UNINSPECTED" : "covered"} (${w.candidateCount} candidate(s))`;
				const notes: string[] = [];
				if (w.uninspected && w.uncoveredSubsegments.length > 0) {
					// Show the CANONICAL uncovered sub-parts so the agent can target exactly
					// the gaps that remain rather than re-covering the whole window.
					notes.push(`still uncovered: ${w.uncoveredSubsegments.map((s) => `${s.startMs}-${s.endMs}ms`).join(", ")}`);
				}
				if ((w.peakOrdinalsNeedingFullRes ?? []).length > 0) {
					const ids = (w.peakFrameIds ?? []).join(", ") || "(inspect_overview first to register the peak frame)";
					notes.push(`peak frame(s) still need a full-resolution read: ${ids}`);
				}
				return notes.length ? `${base}; ${notes.join("; ")}` : base;
			})
		: ["  none"];
	const gaps = status.largeGaps.length ? status.largeGaps.map((g) => `  ${g.startMs}-${g.endMs}ms`) : ["  none"];
	const overflow = (status.unsatisfiedIsolatedTransients ?? []).length
		? status.unsatisfiedIsolatedTransients!.map(
				(s) => `  ${s.startMs}-${s.endMs}ms (over the focus budget; submit 'partial' listing it)`,
			)
		: ["  none"];
	return [
		`Registered frames: ${status.registeredFrames}`,
		"Budgets:",
		...budgetLines,
		"Inspected ranges:",
		...inspected,
		"Mandatory windows to cover before claiming 'complete':",
		...mandatory,
		"Uninspected candidate windows (detail):",
		...uninspected,
		"Large uninspected temporal gaps:",
		...gaps,
		"Isolated transients over the focus budget (force 'partial'):",
		...overflow,
	].join("\n");
}

export function createInspectionStatusTool(
	options: StatusToolOptions,
): CustomVideoTool<typeof ParametersSchema, StatusToolDetails> {
	return {
		name: "get_inspection_status",
		label: "Get Inspection Status",
		description:
			"Return remaining budgets, inspected windows, uninspected candidate windows, and large temporal gaps so completeness is explicit before submitting.",
		promptSnippet: "Check remaining budgets and inspection coverage",
		parameters: ParametersSchema,
		execute: async (): Promise<AgentToolResult<StatusToolDetails>> => {
			const status = options.status();
			return {
				content: [{ type: "text", text: render(status) }],
				details: {
					remainingRangeInspections: status.budgets.rangeInspections.remaining,
					remainingCells: status.budgets.cells.remaining,
					uninspectedCandidates: status.uninspectedCandidates.length,
					uninspectedMandatoryWindows: status.mandatoryWindows.filter((w) => w.uninspected).length,
					largeGaps: status.largeGaps.length,
				},
			};
		},
	};
}
