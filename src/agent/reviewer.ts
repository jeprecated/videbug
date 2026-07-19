/**
 * Reviewer orchestration (implementation plan §9).
 *
 * Drives an `AgentRunner` through the independent reviewer protocol:
 *   1. send the review briefing (validated draft + deterministic source/candidate/
 *      mandatory-window summary; NEVER the analyst transcript or reasoning);
 *   2. if the submit-review latch captured a valid verdict, return it;
 *   3. otherwise send exactly ONE bounded repair turn carrying only the validator
 *      errors from the rejected submission;
 *   4. if still no valid verdict, fail closed with `ReviewerRejectedError` (exit 7).
 *
 * The accepted verdict is always read from the latch, never from assistant prose.
 * A reject-without-valid-replacement is indistinguishable from no submission here:
 * both leave the latch empty and both fail closed at exit 7, exactly as documented.
 *
 * Progress surfaces attempt/rejection COUNTS only — never the verdict rationale or
 * the replacement payload.
 */
import type { SubmitReviewPayload } from "../contracts/review-v1.ts";
import { ReviewerRejectedError } from "../util/errors.ts";
import type { AgentRunner } from "./agent-runner.ts";
import { buildReviewRepairPrompt } from "./prompts.ts";
import type { SubmitReviewTool } from "./tools/submit-review-tool.ts";

export type ReviewerPhase = "briefing" | "repair" | "submitted" | "failed";

export interface ReviewerProgressEvent {
	phase: ReviewerPhase;
	message: string;
}

export interface RunReviewerOptions {
	runner: AgentRunner;
	submit: SubmitReviewTool;
	/** The review briefing (first user turn): draft + deterministic summary only. */
	briefing: string;
	onProgress?: (event: ReviewerProgressEvent) => void;
}

export async function runReviewerOrchestration(options: RunReviewerOptions): Promise<SubmitReviewPayload> {
	const { runner, submit, briefing, onProgress } = options;
	const emit = (phase: ReviewerPhase, message: string) => onProgress?.({ phase, message });

	emit("briefing", "sending reviewer briefing");
	await runner.prompt(briefing);

	let review = submit.getReview();
	if (review) {
		emit(
			"submitted",
			`review captured (${submit.getAttemptCount()} attempt(s), ${submit.getRejectionCount()} rejection(s))`,
		);
		return review;
	}

	// Exactly one bounded repair turn, carrying only the concrete validator errors.
	const errors = submit.getLastErrors();
	emit(
		"repair",
		`review not captured after ${submit.getAttemptCount()} attempt(s) (${submit.getRejectionCount()} rejection(s)); issuing one repair turn (${errors.length} error(s))`,
	);
	await runner.prompt(buildReviewRepairPrompt(errors));

	review = submit.getReview();
	if (review) {
		emit(
			"submitted",
			`review captured (${submit.getAttemptCount()} attempt(s), ${submit.getRejectionCount()} rejection(s))`,
		);
		return review;
	}

	emit(
		"failed",
		`no valid review after one repair turn (${submit.getAttemptCount()} attempt(s), ${submit.getRejectionCount()} rejection(s))`,
	);
	throw new ReviewerRejectedError(
		`The reviewer did not submit a valid accept/replace verdict after one repair turn.${errors.length ? ` Last errors: ${errors.join("; ")}` : ""}`,
	);
}
