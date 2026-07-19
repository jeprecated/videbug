/**
 * `compare_evidence` custom tool.
 *
 * Accepts two or more registered frame IDs and returns deterministic pixel-diff
 * metrics and changed-region grids. It makes no semantic claim about the change —
 * it only reports numbers. Resolution and budget enforcement happen in the
 * backend; an unregistered ID is rejected rather than reaching any path.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ComparisonResult } from "../../evidence/compare.ts";
import type { ToolRejection } from "../../evidence/inspection-context.ts";
import type { CustomVideoTool } from "./tool-types.ts";

export interface CompareToolOptions {
	runCompare(frameIds: readonly string[]): Promise<ComparisonResult | ToolRejection>;
}

export interface ComparePairDetail {
	fromId: string;
	toId: string;
	changedCells: number;
	/** Exact 8×8 per-cell changed-pixel ratios, row-major. */
	grid: number[];
}

export interface CompareToolDetails {
	accepted: boolean;
	pairs: number;
	/** Exact per-pair changed-region grids (authoritative; text is a rounded view). */
	comparisons?: ComparePairDetail[];
	message?: string;
}

const ParametersSchema = Type.Object({
	frameIds: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 2,
		description: "Two or more registered frame IDs to compare, in order.",
	}),
});

/** Render the row-major 8×8 grid as eight lines of two-decimal changed-pixel ratios. */
function formatGrid(grid: number[]): string {
	const rows: string[] = [];
	for (let r = 0; r < 8; r++) {
		rows.push(
			`    ${grid
				.slice(r * 8, r * 8 + 8)
				.map((v) => v.toFixed(2))
				.join(" ")}`,
		);
	}
	return rows.join("\n");
}

function summarize(result: ComparisonResult): string {
	const blocks = result.pairs.map((p) => {
		const header = `${p.fromId} -> ${p.toId}\tabsDiffMean=${p.absDiffMean.toFixed(2)}\tchangedPixels=${p.changedPixelRatio.toFixed(4)}\tdHashDist=${p.dHashDistance}\tchangedCells=${p.changedCells}/64`;
		return `${header}\n  changed-region grid (8x8, changed-pixel ratio per cell, row-major):\n${formatGrid(p.grid)}`;
	});
	return ["Deterministic pixel-diff metrics (no semantic claim):", ...blocks].join("\n");
}

export function createCompareEvidenceTool(
	options: CompareToolOptions,
): CustomVideoTool<typeof ParametersSchema, CompareToolDetails> {
	return {
		name: "compare_evidence",
		label: "Compare Evidence",
		description:
			"Compare two or more registered frames and return deterministic pixel-diff metrics and changed-region grids. Reports numbers only; makes no semantic claim.",
		promptSnippet: "Get deterministic diff metrics between registered frames",
		parameters: ParametersSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<CompareToolDetails>> => {
			const result = await options.runCompare(params.frameIds);
			if ("ok" in result && result.ok === false) {
				return {
					content: [{ type: "text", text: `compare_evidence rejected: ${result.message}` }],
					details: { accepted: false, pairs: 0, message: result.message },
				};
			}
			const comparison = result as ComparisonResult;
			return {
				content: [{ type: "text", text: summarize(comparison) }],
				details: {
					accepted: true,
					pairs: comparison.pairs.length,
					comparisons: comparison.pairs.map((p) => ({
						fromId: p.fromId,
						toId: p.toId,
						changedCells: p.changedCells,
						grid: p.grid,
					})),
				},
			};
		},
	};
}
