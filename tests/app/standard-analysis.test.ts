import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildStandardRunManifest,
	runStandardAnalysis,
	selectReviewedPayload,
} from "../../src/app/standard-analysis.ts";
import type { AnalysisResultV1, SubmitAnalysisPayload } from "../../src/contracts/analysis-v1.ts";
import type { SubmitReviewPayload } from "../../src/contracts/review-v1.ts";
import type { InspectionStatus } from "../../src/evidence/inspection-context.ts";
import { PiUnavailableError } from "../../src/util/errors.ts";

const authStorage = AuthStorage.create(join(mkdtempSync(join(tmpdir(), "vtd-std-")), "auth.json"));
const modelRegistry = ModelRegistry.inMemory(authStorage);

function draft(overrides: Partial<SubmitAnalysisPayload> = {}): SubmitAnalysisPayload {
	return {
		schemaVersion: "1",
		status: "complete",
		coverage: { analyzedStartMs: 0, analyzedEndMs: 2000, uninspectedRanges: [], confidence: "high" },
		summary: { observedFailure: "draft", chronology: "y" },
		beats: [],
		anomalies: [],
		handoff: { reproductionSteps: [], suggestedInvestigations: [], uncertainties: [] },
		...overrides,
	};
}

function status(seed: number): InspectionStatus {
	return {
		budgets: {
			rangeInspections: { limit: 12, used: seed, remaining: 12 - seed },
			overviewInspections: { limit: 4, used: 1, remaining: 3 },
			cells: { limit: 250, used: seed * 10, remaining: 250 - seed * 10 },
			fullResolutionFrames: { limit: 12, used: seed, remaining: 12 - seed },
			comparisons: { limit: 8, used: 0, remaining: 8 },
		} as unknown as InspectionStatus["budgets"],
		registeredFrames: seed * 3,
		inspectedRanges: [{ startMs: 0, endMs: seed * 1000, reason: "chronology", samples: seed, density: 1 }],
		uninspectedCandidates: [],
		mandatoryWindows: [
			{ startMs: 0, endMs: 1000, candidateCount: 1, kinds: ["boundary"], uninspected: false, uncoveredSubsegments: [] },
		],
		largeGaps: [],
	};
}

describe("buildStandardRunManifest", () => {
	it("records SEPARATE frozen analyst and reviewer ledgers plus combined provenance", () => {
		const provenance: AnalysisResultV1["provenance"] = {
			toolVersion: "t",
			ffmpegVersion: "f",
			analystModel: "anthropic/claude-opus-4-8",
			reviewerModel: "anthropic/claude-opus-4-8",
			inspectionCalls: 9,
			inspectedCells: 90,
			fullResolutionFrames: 4,
		};
		const source: AnalysisResultV1["source"] = {
			basename: "v.mp4",
			sha256: "a".repeat(64),
			durationMs: 128640,
			width: 100,
			height: 100,
			streamIndex: 0,
			averageFps: 25,
		};
		const manifest = buildStandardRunManifest({
			source,
			provenance,
			verdict: "accept",
			candidateCount: 42,
			analyst: { model: "anthropic/claude-opus-4-8", status: status(5), submitAttempts: 2, submitRejections: 1 },
			reviewer: { model: "anthropic/claude-opus-4-8", status: status(2), reviewAttempts: 1, reviewRejections: 0 },
		}) as Record<string, unknown>;

		expect(manifest.manifest).toBe("videbug/standard");
		expect(manifest.provenance).toEqual(provenance);
		// Analyst and reviewer ledgers are separate and frozen (distinct usage/ranges).
		const analyst = manifest.analyst as Record<string, unknown>;
		const reviewer = manifest.reviewer as Record<string, unknown>;
		expect(analyst.submitAttempts).toBe(2);
		expect(analyst.submitRejections).toBe(1);
		expect(reviewer.reviewAttempts).toBe(1);
		expect(analyst.budgets).toEqual(status(5).budgets);
		expect(reviewer.budgets).toEqual(status(2).budgets);
		expect(analyst.inspectedRanges).toEqual(status(5).inspectedRanges);
		expect(reviewer.inspectedRanges).toEqual(status(2).inspectedRanges);
		expect(analyst.mandatoryWindows).toEqual(status(5).mandatoryWindows);
		expect(reviewer.mandatoryWindows).toEqual(status(2).mandatoryWindows);
		expect(analyst.registeredFrames).toBe(15);
		expect(reviewer.registeredFrames).toBe(6);
		expect(manifest.reviewerVerdict).toBe("accept");
		expect(manifest.candidateCount).toBe(42);
		// No transcript/reasoning/rationale fields are ever recorded.
		const serialized = JSON.stringify(manifest).toLowerCase();
		expect(serialized).not.toContain("rationale");
		expect(serialized).not.toContain("transcript");
		expect(serialized).not.toContain("reasoning");
	});
});

describe("selectReviewedPayload", () => {
	it("keeps the analyst draft unchanged on an accept verdict", () => {
		const d = draft();
		const review: SubmitReviewPayload = { verdict: "accept", rationale: "solid" };
		expect(selectReviewedPayload(d, review)).toBe(d);
	});

	it("uses the complete replacement on a replace verdict", () => {
		const d = draft();
		const replacement = draft({ summary: { observedFailure: "corrected", chronology: "z" } });
		const review: SubmitReviewPayload = { verdict: "replace", rationale: "missed a transient", replacement };
		expect(selectReviewedPayload(d, review)).toBe(replacement);
	});
});

describe("runStandardAnalysis fail-closed gates", () => {
	it("fails closed (exit 4) for a text-only analyst model, before touching the video", async () => {
		const textOnly = modelRegistry.getAll().find((m) => !m.input.includes("image"));
		expect(textOnly).toBeDefined();
		const error = await runStandardAnalysis({
			videoPath: "/nonexistent/never-read.mp4",
			model: `${textOnly!.provider}/${textOnly!.id}`,
			modelResolution: { authStorage, modelRegistry },
		}).catch((e) => e);
		expect(error).toBeInstanceOf(PiUnavailableError);
		expect((error as PiUnavailableError).exitCode).toBe(4);
	});

	it("fails closed (exit 4) when a text-only --review-model is requested", async () => {
		const vision = modelRegistry.getAll().find((m) => m.input.includes("image"))!;
		const textOnly = modelRegistry.getAll().find((m) => !m.input.includes("image"))!;
		const error = await runStandardAnalysis({
			videoPath: "/nonexistent/never-read.mp4",
			model: `${vision.provider}/${vision.id}`,
			reviewModel: `${textOnly.provider}/${textOnly.id}`,
			modelResolution: { authStorage, modelRegistry },
		}).catch((e) => e);
		expect(error).toBeInstanceOf(PiUnavailableError);
		expect((error as PiUnavailableError).exitCode).toBe(4);
	});
});
