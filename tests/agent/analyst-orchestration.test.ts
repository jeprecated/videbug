import { describe, expect, it } from "vitest";
import { runAnalystOrchestration } from "../../src/agent/analyst.ts";
import { createSubmitAnalysisTool } from "../../src/agent/tools/submit-analysis-tool.ts";
import type { SubmitAnalysisPayload } from "../../src/contracts/analysis-v1.ts";
import { AgentSubmissionError } from "../../src/util/errors.ts";
import { ScriptedAgentRunner } from "../helpers/scripted-runner.ts";

function validPayload(overrides: Partial<SubmitAnalysisPayload> = {}): SubmitAnalysisPayload {
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

describe("runAnalystOrchestration (scripted fake runner)", () => {
	it("returns the captured result when the analyst submits validly on the first turn", async () => {
		const submit = createSubmitAnalysisTool();
		const runner = new ScriptedAgentRunner([async () => void (await submit.tool.execute("c1", validPayload()))]);

		const result = await runAnalystOrchestration({ runner, submit, briefing: "brief" });

		expect(result.beats[0]?.id).toBe("B1");
		// Only the briefing turn was issued — no repair.
		expect(runner.prompts).toHaveLength(1);
		expect(runner.prompts[0]).toBe("brief");
	});

	it("issues exactly one repair turn after an invalid submission, then succeeds", async () => {
		const submit = createSubmitAnalysisTool();
		const runner = new ScriptedAgentRunner([
			// Turn 1: schema-invalid submission — must not latch.
			async () => {
				await submit.tool.execute("c1", { ...validPayload(), schemaVersion: "9" } as unknown as SubmitAnalysisPayload);
			},
			// Turn 2 (repair): valid submission.
			async () => void (await submit.tool.execute("c2", validPayload())),
		]);

		const phases: string[] = [];
		const result = await runAnalystOrchestration({
			runner,
			submit,
			briefing: "brief",
			onProgress: (e) => phases.push(e.phase),
		});

		expect(result.beats[0]?.id).toBe("B1");
		expect(runner.prompts).toHaveLength(2);
		// The repair prompt carries the concrete validator errors from the rejection.
		expect(runner.prompts[1]).toContain("final attempt");
		expect(phases).toEqual(["briefing", "repair", "submitted"]);
	});

	it("fails with exit code 6 when the analyst never submits (at most one repair)", async () => {
		const submit = createSubmitAnalysisTool();
		// No turn ever submits.
		const runner = new ScriptedAgentRunner([async () => {}, async () => {}, async () => {}]);

		await expect(runAnalystOrchestration({ runner, submit, briefing: "brief" })).rejects.toBeInstanceOf(
			AgentSubmissionError,
		);
		// Briefing + exactly one repair = 2 prompts. Never a third attempt.
		expect(runner.prompts).toHaveLength(2);
	});

	it("keeps the first valid result immutable when the analyst re-submits", async () => {
		const submit = createSubmitAnalysisTool();
		const runner = new ScriptedAgentRunner([
			async () => {
				await submit.tool.execute("c1", validPayload({ summary: { observedFailure: "first", chronology: "y" } }));
				// A second submission in the same turn must be ignored (latch immutable).
				await submit.tool.execute("c2", validPayload({ summary: { observedFailure: "second", chronology: "y" } }));
			},
		]);

		const result = await runAnalystOrchestration({ runner, submit, briefing: "brief" });
		expect(result.summary.observedFailure).toBe("first");
		expect(runner.prompts).toHaveLength(1);
	});

	it("repairs a registry-backed cross-validation rejection without accepting invalid state", async () => {
		// The injected validator rejects a citation not in the registry (turn 1),
		// then accepts the corrected payload (turn 2).
		const registry = new Set(["v0_f000000_p000000_aaaaaa"]);
		const submit = createSubmitAnalysisTool({
			validate: (payload) => {
				const bad = payload.beats.flatMap((b) => b.evidence).filter((e) => !registry.has(e.frameId));
				return bad.length ? { ok: false, errors: bad.map((e) => `unknown frame ${e.frameId}`) } : { ok: true };
			},
		});
		const runner = new ScriptedAgentRunner([
			async () => {
				const bad = validPayload();
				bad.beats[0]!.evidence = [{ frameId: "ghost", ptsMs: 0, role: "representative" }];
				await submit.tool.execute("c1", bad);
			},
			async () => void (await submit.tool.execute("c2", validPayload())),
		]);

		const result = await runAnalystOrchestration({ runner, submit, briefing: "brief" });
		expect(result.beats[0]?.evidence[0]?.frameId).toBe("v0_f000000_p000000_aaaaaa");
		expect(runner.prompts[1]).toContain("unknown frame ghost");
	});
});
