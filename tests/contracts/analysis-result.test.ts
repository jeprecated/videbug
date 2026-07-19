import { describe, expect, it } from "vitest";
import {
	type AnalysisProvenance,
	type AnalysisSource,
	composeAnalysisResult,
	validateAnalysisResultSchema,
} from "../../src/contracts/analysis-v1.ts";
import type { SubmitAnalysisPayload } from "../../src/contracts/analysis-v1.ts";

function payload(): SubmitAnalysisPayload {
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

const source: AnalysisSource = {
	basename: "recording.mp4",
	sha256: "a".repeat(64),
	durationMs: 2000,
	width: 1080,
	height: 1920,
	streamIndex: 0,
	averageFps: 30,
};

const provenance: AnalysisProvenance = {
	toolVersion: "0.0.0",
	ffmpegVersion: "8.1.1",
	analystModel: "anthropic/claude-opus-4-5",
	inspectionCalls: 3,
	inspectedCells: 40,
	fullResolutionFrames: 2,
};

describe("composeAnalysisResult", () => {
	it("injects deterministic source and provenance into the semantic payload", () => {
		const result = composeAnalysisResult(payload(), { source, provenance });
		expect(result.source).toEqual(source);
		expect(result.provenance).toEqual(provenance);
		expect(result.schemaVersion).toBe("1");
		expect(result.beats).toHaveLength(1);
	});

	it("produces a result that passes the full schema check", () => {
		const result = composeAnalysisResult(payload(), { source, provenance });
		const check = validateAnalysisResultSchema(result);
		expect(check.ok).toBe(true);
	});

	it("supports an optional reviewer model in provenance", () => {
		const result = composeAnalysisResult(payload(), {
			source,
			provenance: { ...provenance, reviewerModel: "anthropic/claude-sonnet-4-5" },
		});
		expect(result.provenance.reviewerModel).toBe("anthropic/claude-sonnet-4-5");
		expect(validateAnalysisResultSchema(result).ok).toBe(true);
	});

	it("does not mutate or alias the caller's payload", () => {
		const p = payload();
		const result = composeAnalysisResult(p, { source, provenance });
		result.beats[0]!.observation.summary = "changed";
		expect(p.beats[0]!.observation.summary).toBe("idle");
	});
});

describe("validateAnalysisResultSchema", () => {
	it("rejects a result missing the injected source", () => {
		const { source: _omitted, ...withoutSource } = composeAnalysisResult(payload(), { source, provenance });
		const check = validateAnalysisResultSchema(withoutSource);
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.errors.join("\n")).toMatch(/source/i);
	});

	it("rejects a non-integer streamIndex claim from the model side", () => {
		const result = composeAnalysisResult(payload(), { source, provenance });
		const bad = { ...result, source: { ...result.source, sha256: "short" } };
		const check = validateAnalysisResultSchema(bad);
		expect(check.ok).toBe(false);
	});
});
