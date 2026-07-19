/**
 * `inspect_range` custom tool.
 *
 * Resolves a `[startMs, endMs]` window and a bounded `samples` count to explicit
 * source frames, returns a contact sheet (image) plus the authoritative ordered
 * cell manifest (text), and marks the range inspected. The duplicate/refinement rule
 * and budget enforcement live in the backend, which returns a structured
 * rejection the tool surfaces to the model as text.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatManifestText } from "../../evidence/contact-sheet.ts";
import type { RangeOutput, ToolRejection } from "../../evidence/inspection-context.ts";
import type { InspectionReason } from "../../evidence/registry.ts";
import type { CustomVideoTool } from "./tool-types.ts";

export interface RangeToolOptions {
	runRange(input: {
		startMs: number;
		endMs: number;
		samples: number;
		reason: InspectionReason;
	}): Promise<RangeOutput | ToolRejection>;
	/** Upper bound advertised in the schema (default 24). */
	maxSamples?: number;
}

export interface RangeToolDetails {
	accepted: boolean;
	samples: number;
	resolvedStartMs?: number;
	resolvedEndMs?: number;
	message?: string;
}

const ReasonSchema = Type.Union([
	Type.Literal("boundary"),
	Type.Literal("transient"),
	Type.Literal("text"),
	Type.Literal("loading-duration"),
	Type.Literal("chronology"),
]);

export function createRangeTool(
	options: RangeToolOptions,
): CustomVideoTool<ReturnType<typeof schema>, RangeToolDetails> {
	const maxSamples = options.maxSamples ?? 24;
	const ParametersSchema = schema(maxSamples);
	return {
		name: "inspect_range",
		label: "Inspect Range",
		description:
			"Sample explicit source frames in a time window and return a contact sheet with an authoritative ordered cell manifest. A same-reason request that adds uncovered territory is allowed; a span already fully covered for that reason requires higher density to refine it.",
		promptSnippet: "Zoom into a time window at a chosen sampling density",
		parameters: ParametersSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<RangeToolDetails>> => {
			const output = await options.runRange({
				startMs: params.startMs,
				endMs: params.endMs,
				samples: params.samples,
				reason: params.reason as InspectionReason,
			});
			if (!output.ok) {
				return {
					content: [{ type: "text", text: `inspect_range rejected: ${output.message}` }],
					details: { accepted: false, samples: 0, message: output.message },
				};
			}
			const text = [
				`Range ${output.resolvedStartMs}-${output.resolvedEndMs}ms (${output.reason}), ${output.samples} frame(s).`,
				"The manifest below is authoritative; on-sheet labels are aids.",
				"",
				formatManifestText(output.manifest),
			].join("\n");
			return {
				content: [
					{ type: "text", text },
					{ type: "image", data: output.sheet.data, mimeType: output.sheet.mimeType },
				],
				details: {
					accepted: true,
					samples: output.samples,
					resolvedStartMs: output.resolvedStartMs,
					resolvedEndMs: output.resolvedEndMs,
				},
			};
		},
	};
}

function schema(maxSamples: number) {
	return Type.Object({
		startMs: Type.Number({ minimum: 0, description: "Window start in milliseconds." }),
		endMs: Type.Number({ minimum: 0, description: "Window end in milliseconds." }),
		samples: Type.Integer({ minimum: 1, maximum: maxSamples, description: `Frames to sample (1..${maxSamples}).` }),
		reason: ReasonSchema,
	});
}
