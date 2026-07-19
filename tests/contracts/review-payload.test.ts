import { describe, expect, it } from "vitest";
import type { SubmitAnalysisPayload } from "../../src/contracts/analysis-v1.ts";
import { type SubmitReviewPayload, validateSubmitReviewPayload } from "../../src/contracts/review-v1.ts";

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

describe("validateSubmitReviewPayload", () => {
	it("accepts an 'accept' verdict with a rationale and no replacement", () => {
		const payload: SubmitReviewPayload = { verdict: "accept", rationale: "the draft is well supported" };
		const result = validateSubmitReviewPayload(payload);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.verdict).toBe("accept");
	});

	it("rejects an 'accept' verdict that also carries a replacement (no patch/partial semantics)", () => {
		const payload = { verdict: "accept", rationale: "ok", replacement: validAnalysis() } as SubmitReviewPayload;
		const result = validateSubmitReviewPayload(payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join(" ")).toMatch(/accept.*must not.*replacement/i);
	});

	it("rejects a 'replace' verdict with no replacement payload", () => {
		const payload = { verdict: "replace", rationale: "needs work" } as SubmitReviewPayload;
		const result = validateSubmitReviewPayload(payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.join(" ")).toMatch(/replace.*requires.*replacement/i);
	});

	it("accepts a 'replace' verdict whose replacement is a valid complete AnalysisResultV1 payload", () => {
		const payload: SubmitReviewPayload = {
			verdict: "replace",
			rationale: "the analyst missed a transient",
			replacement: validAnalysis(),
		};
		const result = validateSubmitReviewPayload(payload);
		expect(result.ok).toBe(true);
		if (result.ok && result.value.verdict === "replace") {
			expect(result.value.replacement!.beats[0]?.id).toBe("B1");
		}
	});

	it("surfaces the replacement's own validation errors, prefixed as replacement errors", () => {
		const bad = validAnalysis();
		// Out-of-order beats fail the analyst semantic validator.
		bad.beats = [bad.beats[0]!, { ...bad.beats[0]!, id: "B2", time: { startMs: -5, endMs: 10, precisionMs: 1 } }];
		const payload = { verdict: "replace", rationale: "fix", replacement: bad } as SubmitReviewPayload;
		const result = validateSubmitReviewPayload(payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors.some((e) => e.startsWith("replacement:"))).toBe(true);
	});

	it("rejects an unknown verdict", () => {
		const result = validateSubmitReviewPayload({ verdict: "patch", rationale: "x" });
		expect(result.ok).toBe(false);
	});

	it("rejects a missing rationale", () => {
		const result = validateSubmitReviewPayload({ verdict: "accept" });
		expect(result.ok).toBe(false);
	});
});
