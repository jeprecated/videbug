/**
 * `inspect_overview` custom tool.
 *
 * Returns a full-duration contact sheet (image) plus the authoritative ordered
 * cell manifest and a concise machine-readable candidate-window summary (text).
 * The image is a navigation aid; the text manifest is the source of truth for the
 * cell-to-frame mapping. Frame selection, extraction, and budget enforcement all
 * happen in the injected backend, so this tool contains no path or filesystem
 * access of its own.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatManifestText } from "../../evidence/contact-sheet.ts";
import type { OverviewOutput, ToolRejection } from "../../evidence/inspection-context.ts";
import type { CustomVideoTool } from "./tool-types.ts";

export interface OverviewToolOptions {
	runOverview(): Promise<OverviewOutput | ToolRejection>;
}

export interface OverviewToolDetails {
	accepted: boolean;
	cells: number;
	sheetWidth?: number;
	sheetHeight?: number;
	message?: string;
}

const ParametersSchema = Type.Object({});

function candidateSummaryText(output: OverviewOutput): string {
	if (output.candidateSummary.length === 0) return "candidate-windows: none";
	const lines = output.candidateSummary.map(
		(c) => `${c.kind}\t${c.startMs}-${c.endMs}ms\tscore=${c.score.toFixed(1)}\tframe#${c.representativeOrdinal}`,
	);
	return ["candidate-windows (kind\trange\tscore\trep-ordinal):", ...lines].join("\n");
}

export function createOverviewTool(
	options: OverviewToolOptions,
): CustomVideoTool<typeof ParametersSchema, OverviewToolDetails> {
	return {
		name: "inspect_overview",
		label: "Inspect Overview",
		description:
			"Return a full-duration contact sheet with an authoritative ordered cell manifest and a candidate-window summary. Labels on the sheet are navigation aids; the text manifest is authoritative.",
		promptSnippet: "Get a whole-recording overview contact sheet and candidate summary",
		parameters: ParametersSchema,
		execute: async (): Promise<AgentToolResult<OverviewToolDetails>> => {
			const output = await options.runOverview();
			if (!output.ok) {
				return {
					content: [{ type: "text", text: `inspect_overview rejected: ${output.message}` }],
					details: { accepted: false, cells: 0, message: output.message },
				};
			}
			const text = [
				"Overview contact sheet. The manifest below is authoritative; on-sheet labels are aids.",
				"",
				formatManifestText(output.manifest),
				"",
				candidateSummaryText(output),
			].join("\n");
			return {
				content: [
					{ type: "text", text },
					{ type: "image", data: output.sheet.data, mimeType: output.sheet.mimeType },
				],
				details: {
					accepted: true,
					cells: output.manifest.length,
					sheetWidth: output.sheet.width,
					sheetHeight: output.sheet.height,
				},
			};
		},
	};
}
