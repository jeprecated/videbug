import { describe, expect, it } from "vitest";
import { createSubmitAnalysisTool } from "../../src/agent/tools/submit-analysis-tool.ts";
import type { SubmitAnalysisPayload } from "../../src/contracts/analysis-v1.ts";

function validPayload(): SubmitAnalysisPayload {
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
	};
}

describe("createSubmitAnalysisTool", () => {
	it("captures a valid submission in a latch without parsing prose", async () => {
		const { tool, getResult } = createSubmitAnalysisTool();
		expect(getResult()).toBeUndefined();

		const payload = validPayload();
		const result = await tool.execute("call-1", payload);

		expect(result.details.accepted).toBe(true);
		// Terminate decision: a valid structured submission ends the turn without an
		// extra assistant prose round-trip (Pi SDK AgentToolResult.terminate).
		expect(result.terminate).toBe(true);

		const captured = getResult();
		expect(captured).toBeDefined();
		expect(captured?.beats[0]?.id).toBe("B1");
	});

	it("returns repair errors and does not set the latch for an invalid submission", async () => {
		const { tool, getResult } = createSubmitAnalysisTool();
		const bad = { ...validPayload(), schemaVersion: "9" } as unknown as SubmitAnalysisPayload;

		const result = await tool.execute("call-1", bad);

		expect(result.details.accepted).toBe(false);
		expect(result.terminate).toBeFalsy();
		expect(result.details.errors.length).toBeGreaterThan(0);
		// The error content is fed back for a repair turn, not thrown away.
		expect(result.content[0]?.type).toBe("text");
		expect(getResult()).toBeUndefined();
	});

	it("keeps the first valid result immutable across later submissions", async () => {
		const { tool, getResult } = createSubmitAnalysisTool();
		const first = validPayload();
		await tool.execute("call-1", first);
		const captured = getResult();

		const second = validPayload();
		second.summary.observedFailure = "different";
		const result = await tool.execute("call-2", second);

		expect(result.details.accepted).toBe(false);
		expect(getResult()).toBe(captured);
		expect(getResult()?.summary.observedFailure).toBe("x");
	});

	it("exposes only the submit tool name in its definition", () => {
		const { tool } = createSubmitAnalysisTool();
		expect(tool.name).toBe("submit_analysis");
	});

	it("deep-freezes the captured result so it cannot be mutated after acceptance", async () => {
		const { tool, getResult } = createSubmitAnalysisTool();
		await tool.execute("call-1", validPayload());
		const captured = getResult()!;
		expect(Object.isFrozen(captured)).toBe(true);
		expect(Object.isFrozen(captured.beats)).toBe(true);
		expect(Object.isFrozen(captured.beats[0])).toBe(true);
		expect(() => {
			captured.summary.observedFailure = "tampered";
		}).toThrow();
		expect(getResult()?.summary.observedFailure).toBe("x");
	});

	it("runs an injected cross-validator and does not latch on cross-validation rejection", async () => {
		let calls = 0;
		const { tool, getResult, getLastErrors } = createSubmitAnalysisTool({
			validate: (payload) => {
				calls += 1;
				// Reject the first attempt (simulating a bad citation), accept the repair.
				if (payload.summary.observedFailure === "bad") {
					return { ok: false, errors: ["beats[0] cites frame X not in the evidence registry"] };
				}
				return { ok: true };
			},
		});

		const bad = validPayload();
		bad.summary.observedFailure = "bad";
		const first = await tool.execute("call-1", bad);
		expect(first.details.accepted).toBe(false);
		expect(first.terminate).toBeFalsy();
		expect(getResult()).toBeUndefined();
		expect(getLastErrors()).toEqual(["beats[0] cites frame X not in the evidence registry"]);

		// The invalid state was never accepted, so a repair can succeed cleanly.
		const good = validPayload();
		const second = await tool.execute("call-2", good);
		expect(second.details.accepted).toBe(true);
		expect(second.terminate).toBe(true);
		expect(getResult()?.summary.observedFailure).toBe("x");
		expect(getLastErrors()).toEqual([]);
		expect(calls).toBe(2);
	});

	it("records schema/semantic errors in getLastErrors for a repair prompt", async () => {
		const { tool, getLastErrors } = createSubmitAnalysisTool();
		expect(getLastErrors()).toEqual([]);
		const badOrder = validPayload();
		badOrder.beats.push({
			id: "B2",
			time: { startMs: -1, endMs: 5, precisionMs: 1 },
			kind: "state",
			observation: { summary: "x", visibleText: [], motion: "none" },
			evidence: [],
			confidence: "low",
			inferences: [],
		});
		const result = await tool.execute("call-1", badOrder);
		expect(result.details.accepted).toBe(false);
		expect(getLastErrors().length).toBeGreaterThan(0);
	});

	it("defensively clones the submission so later mutation of the input cannot leak in", async () => {
		const { tool, getResult } = createSubmitAnalysisTool();
		const submitted = validPayload();
		await tool.execute("call-1", submitted);
		// The agent's argument object is mutated after the tool returned.
		submitted.beats[0]!.observation.summary = "mutated-after-submit";
		submitted.beats.push({
			id: "B2",
			time: { startMs: 0, endMs: 1, precisionMs: 1 },
			kind: "state",
			observation: { summary: "injected", visibleText: [], motion: "none" },
			evidence: [],
			confidence: "low",
			inferences: [],
		});
		expect(getResult()?.beats).toHaveLength(1);
		expect(getResult()?.beats[0]?.observation.summary).toBe("idle");
	});
});
