import { describe, expect, it } from "vitest";
import { createSubmitReviewTool } from "../../src/agent/tools/submit-review-tool.ts";
import type { SubmitAnalysisPayload } from "../../src/contracts/analysis-v1.ts";
import type { SubmitReviewPayload } from "../../src/contracts/review-v1.ts";

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

describe("createSubmitReviewTool", () => {
	it("captures an accept verdict in a latch and terminates", async () => {
		const { tool, getReview, getAttemptCount, getRejectionCount } = createSubmitReviewTool();
		const payload: SubmitReviewPayload = { verdict: "accept", rationale: "well supported" };
		const result = await tool.execute("c1", payload);
		expect(result.details.accepted).toBe(true);
		expect(result.terminate).toBe(true);
		expect(getReview()?.verdict).toBe("accept");
		expect(getAttemptCount()).toBe(1);
		expect(getRejectionCount()).toBe(0);
	});

	it("captures a replace verdict and runs the injected cross-validator on the replacement", async () => {
		const seen: SubmitAnalysisPayload[] = [];
		const { tool, getReview } = createSubmitReviewTool({
			validate: (payload) => {
				seen.push(payload);
				return { ok: true };
			},
		});
		const payload: SubmitReviewPayload = {
			verdict: "replace",
			rationale: "missed a transient",
			replacement: validAnalysis(),
		};
		const result = await tool.execute("c1", payload);
		expect(result.details.accepted).toBe(true);
		expect(getReview()?.verdict).toBe("replace");
		expect(seen).toHaveLength(1);
	});

	it("rejects and does not latch when the replacement fails cross-validation, counting the rejection", async () => {
		const { tool, getReview, getLastErrors, getRejectionCount, getAttemptCount } = createSubmitReviewTool({
			validate: () => ({ ok: false, errors: ["beats[0] cites frame X not in the registry"] }),
		});
		const result = await tool.execute("c1", { verdict: "replace", rationale: "x", replacement: validAnalysis() });
		expect(result.details.accepted).toBe(false);
		expect(result.terminate).toBeFalsy();
		expect(getReview()).toBeUndefined();
		expect(getLastErrors()).toEqual(["beats[0] cites frame X not in the registry"]);
		expect(getAttemptCount()).toBe(1);
		expect(getRejectionCount()).toBe(1);
	});

	it("runs the reviewer-live cross-validator on the retained draft before accepting", async () => {
		const draft = validAnalysis();
		const seen: SubmitAnalysisPayload[] = [];
		const { tool, getReview } = createSubmitReviewTool({
			draft,
			validate: (selected) => {
				seen.push(selected);
				return { ok: true };
			},
		});
		const result = await tool.execute("c1", { verdict: "accept", rationale: "ok" });
		expect(result.details.accepted).toBe(true);
		expect(getReview()?.verdict).toBe("accept");
		expect(seen).toEqual([draft]);
	});

	it("rejects accept without latching when the retained analyst partial is premature in the reviewer ledger", async () => {
		const partial = validAnalysis({
			status: "partial",
			coverage: {
				analyzedStartMs: 0,
				analyzedEndMs: 1000,
				uninspectedRanges: [{ startMs: 500, endMs: 1000 }],
				confidence: "medium",
			},
		});
		const error = "status is partial but reviewer allowance remains; inspect the uncovered range";
		const { tool, getReview, getLastErrors, getRejectionCount } = createSubmitReviewTool({
			draft: partial,
			validate: (selected) => (selected.status === "partial" ? { ok: false, errors: [error] } : { ok: true }),
		});
		const result = await tool.execute("c1", { verdict: "accept", rationale: "looks plausible" });
		expect(result.details.accepted).toBe(false);
		expect(result.terminate).toBeFalsy();
		expect(getReview()).toBeUndefined();
		expect(getLastErrors()).toEqual([error]);
		expect(getRejectionCount()).toBe(1);
	});

	it("fails closed when an accept validator is configured without the retained draft", async () => {
		const { tool, getReview, getLastErrors } = createSubmitReviewTool({ validate: () => ({ ok: true }) });
		const result = await tool.execute("c1", { verdict: "accept", rationale: "ok" });
		expect(result.details.accepted).toBe(false);
		expect(getReview()).toBeUndefined();
		expect(getLastErrors()).toEqual([
			"accept validation is unavailable because the retained analyst draft was not configured",
		]);
	});

	it("rejects an accept-with-replacement contract violation without latching", async () => {
		const { tool, getReview, getLastErrors } = createSubmitReviewTool();
		const result = await tool.execute("c1", {
			verdict: "accept",
			rationale: "ok",
			replacement: validAnalysis(),
		} as SubmitReviewPayload);
		expect(result.details.accepted).toBe(false);
		expect(getReview()).toBeUndefined();
		expect(getLastErrors().join(" ")).toMatch(/replacement/i);
	});

	it("keeps the first accepted verdict immutable across later submissions", async () => {
		const { tool, getReview } = createSubmitReviewTool();
		await tool.execute("c1", { verdict: "accept", rationale: "first" });
		const first = getReview();
		const result = await tool.execute("c2", { verdict: "accept", rationale: "second" });
		expect(result.details.accepted).toBe(false);
		expect(getReview()).toBe(first);
		expect(getReview()?.rationale).toBe("first");
	});

	it("deep-freezes the captured replacement so it cannot be mutated after acceptance", async () => {
		const { tool, getReview } = createSubmitReviewTool();
		await tool.execute("c1", { verdict: "replace", rationale: "x", replacement: validAnalysis() });
		const review = getReview();
		expect(review?.verdict).toBe("replace");
		if (review?.verdict === "replace") {
			expect(Object.isFrozen(review.replacement!)).toBe(true);
			expect(() => {
				review.replacement!.summary.observedFailure = "tampered";
			}).toThrow();
		}
	});

	it("exposes the submit_review tool name", () => {
		expect(createSubmitReviewTool().tool.name).toBe("submit_review");
	});
});
