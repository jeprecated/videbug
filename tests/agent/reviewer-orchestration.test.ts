import { describe, expect, it } from "vitest";
import { runReviewerOrchestration } from "../../src/agent/reviewer.ts";
import { createSubmitReviewTool } from "../../src/agent/tools/submit-review-tool.ts";
import type { SubmitAnalysisPayload } from "../../src/contracts/analysis-v1.ts";
import type { SubmitReviewPayload } from "../../src/contracts/review-v1.ts";
import { ReviewerRejectedError } from "../../src/util/errors.ts";
import { ScriptedAgentRunner } from "../helpers/scripted-runner.ts";

function validAnalysis(overrides: Partial<SubmitAnalysisPayload> = {}): SubmitAnalysisPayload {
	return {
		schemaVersion: "1",
		status: "complete",
		coverage: { analyzedStartMs: 0, analyzedEndMs: 2000, uninspectedRanges: [], confidence: "high" },
		summary: { observedFailure: "x", chronology: "y" },
		beats: [
			{
				id: "B1",
				time: { startMs: 0, endMs: 2000, precisionMs: 100 },
				kind: "state",
				observation: { summary: "idle", visibleText: [], motion: "none" },
				evidence: [{ frameId: "v0_f000000_p000000_aaaaaa", ptsMs: 0, role: "representative" }],
				confidence: "high",
				inferences: [],
			},
		],
		anomalies: [],
		handoff: { reproductionSteps: [], suggestedInvestigations: [], uncertainties: [] },
		...overrides,
	};
}

describe("runReviewerOrchestration (scripted fake runner)", () => {
	it("returns an accept verdict captured on the first turn", async () => {
		const submit = createSubmitReviewTool();
		const runner = new ScriptedAgentRunner([
			async () => void (await submit.tool.execute("c1", { verdict: "accept", rationale: "solid" })),
		]);
		const outcome = await runReviewerOrchestration({ runner, submit, briefing: "brief" });
		expect(outcome.verdict).toBe("accept");
		expect(runner.prompts).toHaveLength(1);
	});

	it("returns a replace verdict with the complete replacement payload", async () => {
		const replacement = validAnalysis({ summary: { observedFailure: "corrected", chronology: "z" } });
		const submit = createSubmitReviewTool();
		const runner = new ScriptedAgentRunner([
			async () =>
				void (await submit.tool.execute("c1", {
					verdict: "replace",
					rationale: "missed",
					replacement,
				} as SubmitReviewPayload)),
		]);
		const outcome = await runReviewerOrchestration({ runner, submit, briefing: "brief" });
		expect(outcome.verdict).toBe("replace");
		expect(outcome.replacement!.summary.observedFailure).toBe("corrected");
	});

	it("rejects an untouched reviewer accept of an analyst partial, then allows a complete replacement after coverage repair", async () => {
		const partialDraft = validAnalysis({
			status: "partial",
			coverage: {
				analyzedStartMs: 0,
				analyzedEndMs: 1000,
				uninspectedRanges: [{ startMs: 500, endMs: 1000 }],
				confidence: "medium",
			},
		});
		let reviewerCoverageComplete = false;
		const submit = createSubmitReviewTool({
			draft: partialDraft,
			validate: (selected) => {
				if (!reviewerCoverageComplete) {
					return {
						ok: false,
						errors: ["reviewer allowance remains: inspect the uncovered range before accepting a partial"],
					};
				}
				return selected.status === "complete"
					? { ok: true }
					: { ok: false, errors: ["coverage is now complete; submit a complete replacement"] };
			},
		});
		const runner = new ScriptedAgentRunner([
			async () => {
				await submit.tool.execute("c1", { verdict: "accept", rationale: "draft seems sound" });
			},
			async () => {
				// Represents inspect_range closing the reviewer-live gap during the repair turn.
				reviewerCoverageComplete = true;
				await submit.tool.execute("c2", {
					verdict: "replace",
					rationale: "coverage completed independently",
					replacement: validAnalysis(),
				});
			},
		]);
		const outcome = await runReviewerOrchestration({ runner, submit, briefing: "brief" });
		expect(outcome.verdict).toBe("replace");
		expect(submit.getAttemptCount()).toBe(2);
		expect(submit.getRejectionCount()).toBe(1);
		expect(runner.prompts[1]).toMatch(/inspect the uncovered range/);
	});

	it("issues exactly one bounded repair turn after an invalid submission, then succeeds", async () => {
		const submit = createSubmitReviewTool();
		const runner = new ScriptedAgentRunner([
			async () => {
				await submit.tool.execute("c1", { verdict: "replace", rationale: "x" } as SubmitReviewPayload);
			},
			async () => void (await submit.tool.execute("c2", { verdict: "accept", rationale: "ok" })),
		]);
		const phases: string[] = [];
		const outcome = await runReviewerOrchestration({
			runner,
			submit,
			briefing: "brief",
			onProgress: (e) => phases.push(e.phase),
		});
		expect(outcome.verdict).toBe("accept");
		expect(runner.prompts).toHaveLength(2);
		expect(runner.prompts[1]).toContain("final attempt");
		expect(phases).toEqual(["briefing", "repair", "submitted"]);
	});

	it("fails closed with exit 7 when the reviewer never submits a valid verdict", async () => {
		const submit = createSubmitReviewTool();
		const runner = new ScriptedAgentRunner([async () => {}, async () => {}, async () => {}]);
		await expect(runReviewerOrchestration({ runner, submit, briefing: "brief" })).rejects.toBeInstanceOf(
			ReviewerRejectedError,
		);
		// Briefing + exactly one repair = 2 prompts. Never a third attempt.
		expect(runner.prompts).toHaveLength(2);
	});

	it("fails closed with exit 7 on a reject-without-valid-replacement even after the repair turn", async () => {
		const submit = createSubmitReviewTool({ validate: () => ({ ok: false, errors: ["bad citation"] }) });
		const runner = new ScriptedAgentRunner([
			async () => {
				await submit.tool.execute("c1", { verdict: "replace", rationale: "x", replacement: validAnalysis() });
			},
			async () => {
				await submit.tool.execute("c2", { verdict: "replace", rationale: "x", replacement: validAnalysis() });
			},
		]);
		await expect(runReviewerOrchestration({ runner, submit, briefing: "brief" })).rejects.toBeInstanceOf(
			ReviewerRejectedError,
		);
	});

	it("reports attempt and rejection counts through progress without exposing payloads", async () => {
		const submit = createSubmitReviewTool();
		const runner = new ScriptedAgentRunner([
			async () => {
				await submit.tool.execute("c1", { verdict: "replace", rationale: "x" } as SubmitReviewPayload);
			},
			async () => void (await submit.tool.execute("c2", { verdict: "accept", rationale: "ok" })),
		]);
		const messages: string[] = [];
		await runReviewerOrchestration({ runner, submit, briefing: "brief", onProgress: (e) => messages.push(e.message) });
		const joined = messages.join("\n");
		expect(joined).toMatch(/2 attempt|attempt/i);
		expect(joined).toMatch(/1 rejection|rejection/i);
		// Never leak the rationale/payload text.
		expect(joined).not.toContain("accept");
	});
});
