/**
 * Analyst orchestration (implementation plan §8.4).
 *
 * Drives an `AgentRunner` through the analyst protocol:
 *   1. send the initial source/candidate briefing;
 *   2. if the submit-tool latch captured a valid result, return it;
 *   3. otherwise send exactly ONE bounded repair turn containing only the
 *      validator errors from the rejected submission;
 *   4. if still no valid result, fail with `AgentSubmissionError` (exit 6).
 *
 * The accepted result is always read from the submit latch, never from assistant
 * prose. Invalid submissions never latch, so the single repair turn cannot accept
 * or overwrite invalid state. This function is pure with respect to the runner and
 * submit tool, so the scripted-fake orchestration tests cover success, invalid,
 * absent, repeated, and one-repair behavior without a model.
 */
import type { SubmitAnalysisPayload } from "../contracts/analysis-v1.ts";
import { AgentSubmissionError } from "../util/errors.ts";
import type { AgentRunner } from "./agent-runner.ts";
import { buildRepairPrompt } from "./prompts.ts";
import type { SubmitAnalysisTool } from "./tools/submit-analysis-tool.ts";

export type AnalystPhase = "briefing" | "repair" | "submitted" | "failed";

export interface AnalystProgressEvent {
	phase: AnalystPhase;
	message: string;
}

export interface RunAnalystOptions {
	runner: AgentRunner;
	submit: SubmitAnalysisTool;
	/** The initial source/candidate briefing (first user turn). */
	briefing: string;
	onProgress?: (event: AnalystProgressEvent) => void;
}

export async function runAnalystOrchestration(options: RunAnalystOptions): Promise<SubmitAnalysisPayload> {
	const { runner, submit, briefing, onProgress } = options;
	const emit = (phase: AnalystPhase, message: string) => onProgress?.({ phase, message });

	emit("briefing", "sending analyst briefing");
	await runner.prompt(briefing);

	let result = submit.getResult();
	if (result) {
		emit(
			"submitted",
			`valid analysis captured (${submit.getAttemptCount()} submit attempt(s), ${submit.getRejectionCount()} rejection(s), no repair turn)`,
		);
		return result;
	}

	// Exactly one bounded repair turn, carrying only the concrete validator errors.
	const errors = submit.getLastErrors();
	emit(
		"repair",
		`submission not captured after ${submit.getAttemptCount()} attempt(s) (${submit.getRejectionCount()} rejection(s)); issuing one repair turn (${errors.length} error(s))`,
	);
	await runner.prompt(buildRepairPrompt(errors));

	result = submit.getResult();
	if (result) {
		emit(
			"submitted",
			`valid analysis captured after one repair turn (${submit.getAttemptCount()} submit attempt(s), ${submit.getRejectionCount()} rejection(s))`,
		);
		return result;
	}

	emit("failed", "no valid analysis after one repair turn");
	throw new AgentSubmissionError(
		`The analyst did not submit a valid AnalysisResultV1 after one repair turn.${errors.length ? ` Last errors: ${errors.join("; ")}` : ""}`,
	);
}
