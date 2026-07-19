/**
 * `submit_analysis` custom tool.
 *
 * This is the trust boundary for the analyst's result. The agent submits a
 * complete `AnalysisResultV1` semantic payload as structured tool arguments; the
 * tool validates it and, on success, stores an immutable copy in a closure the
 * CLI observes. The CLI never parses the assistant's free-form prose — the only
 * accepted result is the one captured here.
 *
 * Terminate decision (Pi SDK 0.80.7): a valid submission returns
 * `terminate: true`, so the agent ends its turn on the tool call without paying
 * for an extra assistant round-trip. `AgentToolResult.terminate` is a documented,
 * type-checked field in this SDK version (see docs/adr/0001-m0-contracts-and-spikes.md),
 * so no prose-stop fallback is required.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	type SubmitAnalysisPayload,
	SubmitAnalysisPayloadSchema,
	validateSubmitPayload,
} from "../../contracts/analysis-v1.ts";
import { deepFreeze } from "../../util/freeze.ts";
import type { CustomVideoTool } from "./tool-types.ts";

export interface SubmitToolDetails {
	accepted: boolean;
	errors: string[];
}

/**
 * Extra validation beyond schema + basic ordering: the wiring injects a
 * registry-backed cross-reference/citation/coverage validator here. It runs on a
 * structurally-valid payload and must return concrete repair errors on rejection.
 * A rejection never latches, so an invalid submission can be repaired without ever
 * accepting or overwriting invalid state.
 */
export type SubmitCrossValidator = (payload: SubmitAnalysisPayload) => { ok: true } | { ok: false; errors: string[] };

export interface CreateSubmitAnalysisToolOptions {
	validate?: SubmitCrossValidator;
}

export interface SubmitAnalysisTool {
	tool: CustomVideoTool<typeof SubmitAnalysisPayloadSchema, SubmitToolDetails>;
	/** The captured, validated, immutable result, or undefined until one is accepted. */
	getResult(): SubmitAnalysisPayload | undefined;
	/** Errors from the most recent rejected submission (empty once one is accepted). */
	getLastErrors(): string[];
	/** Total submit_analysis calls seen (accepted or rejected). Runtime observability. */
	getAttemptCount(): number;
	/** Total rejected submit_analysis calls. Never exposes payloads or reasoning. */
	getRejectionCount(): number;
}

const PROMPT_GUIDELINES = [
	"Call submit_analysis exactly once, as your final action, with the complete AnalysisResultV1 semantic payload.",
	"Do not include source or provenance fields; the tool injects those.",
	"If the tool reports validation errors, fix exactly those fields and submit again.",
];

export function createSubmitAnalysisTool(options: CreateSubmitAnalysisToolOptions = {}): SubmitAnalysisTool {
	let captured: SubmitAnalysisPayload | undefined;
	let lastErrors: string[] = [];
	let attempts = 0;
	let rejections = 0;

	const tool: CustomVideoTool<typeof SubmitAnalysisPayloadSchema, SubmitToolDetails> = {
		name: "submit_analysis",
		label: "Submit Analysis",
		description:
			"Submit the final, complete AnalysisResultV1 semantic payload. Validated on receipt; invalid submissions return concrete repair errors.",
		promptSnippet: "Submit the final structured analysis result",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: SubmitAnalysisPayloadSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<SubmitToolDetails>> => {
			attempts += 1;
			// The latch is single-assignment: once a valid result is captured it is
			// immutable, and later submissions cannot overwrite it.
			if (captured) {
				return {
					content: [
						{
							type: "text",
							text: "A valid analysis was already submitted. The first accepted result is final and cannot be replaced.",
						},
					],
					details: { accepted: false, errors: ["result already submitted"] },
				};
			}

			const result = validateSubmitPayload(params);
			if (!result.ok) {
				lastErrors = result.errors;
				rejections += 1;
				return rejection(result.errors);
			}

			// Registry-backed cross-reference/citation/coverage validation. A rejection
			// here must NOT latch, so invalid state is never accepted or overwritten.
			if (options.validate) {
				const cross = options.validate(result.value);
				if (!cross.ok) {
					lastErrors = cross.errors;
					rejections += 1;
					return rejection(cross.errors);
				}
			}

			// Defensively clone and deep-freeze: the latch must not alias the agent's
			// argument object (which could still be mutated) and the accepted result is
			// immutable once captured.
			captured = deepFreeze(structuredClone(result.value));
			lastErrors = [];
			return {
				content: [{ type: "text", text: "Analysis accepted." }],
				details: { accepted: true, errors: [] },
				terminate: true,
			};
		},
	};

	return {
		tool,
		getResult: () => captured,
		getLastErrors: () => [...lastErrors],
		getAttemptCount: () => attempts,
		getRejectionCount: () => rejections,
	};
}

function rejection(errors: string[]): AgentToolResult<SubmitToolDetails> {
	return {
		content: [
			{
				type: "text",
				text: `Submission rejected. Fix these and submit again:\n${errors.map((e) => `- ${e}`).join("\n")}`,
			},
		],
		details: { accepted: false, errors },
	};
}
