import { describe, expect, it } from "vitest";
import { type SubmitAnalysisPayload, validateSubmitPayload } from "../../src/contracts/analysis-v1.ts";

function validPayload(): SubmitAnalysisPayload {
	return {
		schemaVersion: "1",
		status: "complete",
		coverage: {
			analyzedStartMs: 0,
			analyzedEndMs: 2000,
			uninspectedRanges: [],
			confidence: "high",
		},
		summary: {
			observedFailure: "The stack view clears and then restores.",
			chronology: "Idle, then a brief cleared state, then restore.",
		},
		beats: [
			{
				id: "B1",
				time: { startMs: 0, endMs: 1000, precisionMs: 100 },
				kind: "state",
				observation: { summary: "Idle session stack visible.", visibleText: ["Waiting"], motion: "none" },
				evidence: [{ frameId: "v0_f000000_p000000_aaaaaa", ptsMs: 0, role: "representative" }],
				confidence: "high",
				inferences: [],
			},
			{
				id: "B2",
				time: { startMs: 1000, endMs: 2000, precisionMs: 100 },
				kind: "transition",
				observation: { summary: "Stack cleared then restored.", visibleText: [], motion: "global-transition" },
				transitionFromPrevious: "Session Stack cleared",
				evidence: [{ frameId: "v0_f000019_p001900_bbbbbb", ptsMs: 1900, role: "boundary" }],
				confidence: "medium",
				inferences: [{ statement: "Likely a re-render race.", basis: "inference" }],
			},
		],
		anomalies: [
			{
				category: "contradictory-state",
				severity: "warning",
				description: "Stack cleared momentarily.",
				whySuspicious: "State reverted without user action.",
				beatIds: ["B2"],
				evidence: [{ frameId: "v0_f000019_p001900_bbbbbb", ptsMs: 1900, role: "boundary" }],
				confidence: "medium",
				uncertainties: ["Cause not visible."],
			},
		],
		handoff: {
			reproductionSteps: ["Open session stack.", "Wait for reload."],
			suggestedInvestigations: [{ statement: "Inspect stack reload logic.", kind: "action" }],
			uncertainties: ["Backend behavior not observable."],
		},
	};
}

describe("validateSubmitPayload", () => {
	it("accepts a schema-valid submit payload", () => {
		const result = validateSubmitPayload(validPayload());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.beats).toHaveLength(2);
		}
	});

	it("rejects an unknown schema version", () => {
		const bad = { ...validPayload(), schemaVersion: "2" };
		const result = validateSubmitPayload(bad);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join("\n")).toMatch(/schemaVersion/i);
	});

	it("rejects a missing required field", () => {
		const { summary: _omitted, ...bad } = validPayload();
		const result = validateSubmitPayload(bad);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
	});

	it("rejects beats that are not ordered by start time", () => {
		const bad = validPayload();
		bad.beats = [bad.beats[1]!, bad.beats[0]!];
		const result = validateSubmitPayload(bad);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join("\n")).toMatch(/order/i);
	});

	it("rejects an anomaly that references an unknown beat id", () => {
		const bad = validPayload();
		bad.anomalies[0]!.beatIds = ["B99"];
		const result = validateSubmitPayload(bad);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join("\n")).toMatch(/B99/);
	});

	it("rejects non-string prose instead of throwing", () => {
		const result = validateSubmitPayload("not a payload");
		expect(result.ok).toBe(false);
	});
});
