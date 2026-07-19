/**
 * `submit_review` custom tool (implementation plan §9).
 *
 * The trust boundary for the independent reviewer's verdict. The reviewer submits
 * a structured `SubmitReviewPayload`; the tool validates the accept/replace
 * contract and runs the selected semantic payload (retained draft or replacement)
 * through the same live registry/coverage validator the analyst's submission passed.
 * On success it latches an immutable verdict the CLI
 * observes. Assistant prose is never parsed — only this structured payload counts.
 *
 * The tool also counts submit attempts and rejections so the CLI can surface
 * runtime observability (attempt/rejection counts) WITHOUT ever exposing the
 * payload or the reviewer's reasoning.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { SubmitAnalysisPayload } from "../../contracts/analysis-v1.ts";
import {
	type SubmitReviewPayload,
	SubmitReviewPayloadSchema,
	validateSubmitReviewPayload,
} from "../../contracts/review-v1.ts";
import { deepFreeze } from "../../util/freeze.ts";
import type { CustomVideoTool } from "./tool-types.ts";

export interface ReviewToolDetails {
	accepted: boolean;
	verdict?: "accept" | "replace";
	errors: string[];
}

/**
 * Cross-validator for whichever analysis payload a verdict selects. Injected by the
 * wiring so BOTH an accepted draft and a replacement are checked against the
 * reviewer's LIVE evidence registry, coverage state, and independent allowance.
 */
export type ReviewSelectedPayloadValidator = (
	payload: SubmitAnalysisPayload,
) => { ok: true } | { ok: false; errors: string[] };

export interface CreateSubmitReviewToolOptions {
	/** The immutable analyst semantic draft retained by an `accept` verdict. */
	draft?: SubmitAnalysisPayload;
	/** Live reviewer-context validator. When supplied, accept fails closed without `draft`. */
	validate?: ReviewSelectedPayloadValidator;
}

export interface SubmitReviewTool {
	tool: CustomVideoTool<typeof SubmitReviewPayloadSchema, ReviewToolDetails>;
	/** The captured, validated, immutable verdict, or undefined until one is accepted. */
	getReview(): SubmitReviewPayload | undefined;
	/** Errors from the most recent rejected submission (empty once one is accepted). */
	getLastErrors(): string[];
	/** Total submit_review calls seen (accepted or rejected). Runtime observability. */
	getAttemptCount(): number;
	/** Total rejected submit_review calls. Never exposes payloads or reasoning. */
	getRejectionCount(): number;
}

const PROMPT_GUIDELINES = [
	"Call submit_review exactly once, as your final action.",
	"Use verdict 'accept' to keep the analyst draft UNCHANGED, with an evidence-backed rationale.",
	"Use verdict 'replace' only with a COMPLETE replacement AnalysisResultV1 payload; there is no patch or partial form.",
	"If the tool reports validation errors, fix exactly those and submit again.",
];

export function createSubmitReviewTool(options: CreateSubmitReviewToolOptions = {}): SubmitReviewTool {
	let captured: SubmitReviewPayload | undefined;
	let lastErrors: string[] = [];
	let attempts = 0;
	let rejections = 0;

	const tool: CustomVideoTool<typeof SubmitReviewPayloadSchema, ReviewToolDetails> = {
		name: "submit_review",
		label: "Submit Review",
		description:
			"Submit the final review verdict: 'accept' to keep the analyst draft unchanged, or 'replace' with a complete replacement AnalysisResultV1 payload. Validated on receipt; invalid submissions return concrete repair errors.",
		promptSnippet: "Submit the final structured review verdict",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: SubmitReviewPayloadSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<ReviewToolDetails>> => {
			attempts += 1;

			if (captured) {
				return {
					content: [
						{
							type: "text",
							text: "A valid review was already submitted. The first accepted verdict is final and cannot be replaced.",
						},
					],
					details: { accepted: false, errors: ["review already submitted"] },
				};
			}

			const structural = validateSubmitReviewPayload(params);
			if (!structural.ok) {
				lastErrors = structural.errors;
				rejections += 1;
				return rejection(structural.errors);
			}

			// Whichever semantic payload the verdict SELECTS must pass the reviewer-live
			// registry + coverage + allowance validator. In particular, `accept` cannot
			// preserve an analyst partial while the fresh reviewer can still close gaps.
			// Any rejection here must NOT latch.
			if (options.validate) {
				const selected = structural.value.verdict === "replace" ? structural.value.replacement! : options.draft;
				if (selected === undefined) {
					const errors = ["accept validation is unavailable because the retained analyst draft was not configured"];
					lastErrors = errors;
					rejections += 1;
					return rejection(errors);
				}
				const cross = options.validate(selected);
				if (!cross.ok) {
					lastErrors = cross.errors;
					rejections += 1;
					return rejection(cross.errors);
				}
			}

			captured = deepFreeze(structuredClone(structural.value));
			lastErrors = [];
			return {
				content: [{ type: "text", text: `Review accepted (verdict: ${captured.verdict}).` }],
				details: { accepted: true, verdict: captured.verdict, errors: [] },
				terminate: true,
			};
		},
	};

	return {
		tool,
		getReview: () => captured,
		getLastErrors: () => [...lastErrors],
		getAttemptCount: () => attempts,
		getRejectionCount: () => rejections,
	};
}

function rejection(errors: string[]): AgentToolResult<ReviewToolDetails> {
	return {
		content: [
			{
				type: "text",
				text: `Review rejected. Fix these and submit again:\n${errors.map((e) => `- ${e}`).join("\n")}`,
			},
		],
		details: { accepted: false, errors },
	};
}
