/**
 * Opt-in live end-to-end standard-analysis smoke test (milestone M5).
 *
 * Skipped unless V2D_LIVE=1 and Pi auth for a vision-capable model is available.
 * It runs the real default `--mode standard` flow (analyst + fresh independent
 * reviewer) on a small deterministic fixture and asserts a validated
 * `AnalysisResultV1` with registry-backed citations, combined provenance, and a
 * `reviewerModel`. It is NOT a deterministic CI gate.
 *
 * Run with:  V2D_LIVE=1 npx vitest run tests/live/standard-analysis-smoke.test.ts
 */
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { runStandardAnalysis } from "../../src/app/standard-analysis.ts";
import { STATIC_FIXTURE, ensureFixtures } from "../helpers/fixtures.ts";

const LIVE = process.env.V2D_LIVE === "1";
const MODEL = process.env.V2D_LIVE_MODEL ?? "anthropic/claude-opus-4-8";

describe.skipIf(!LIVE)("live standard analysis", () => {
	it("produces a validated, reviewed AnalysisResultV1 with combined provenance", async () => {
		await ensureFixtures();
		const authStorage = AuthStorage.create();
		const modelRegistry = ModelRegistry.create(authStorage);
		if (!modelRegistry.getAvailable().some((m) => m.input.includes("image"))) {
			console.warn("[live] no vision-capable model with configured auth; skipping");
			return;
		}

		const result = await runStandardAnalysis({
			videoPath: STATIC_FIXTURE.path,
			model: MODEL,
			maxAgentTurns: 20,
			modelResolution: { authStorage, modelRegistry },
			onProgress: (e) => console.error(`[live] ${e.phase}: ${e.message}`),
		});

		expect(result.schemaVersion).toBe("1");
		expect(result.beats.length).toBeGreaterThan(0);
		expect(result.provenance.analystModel).toContain("/");
		// Standard mode always ran a reviewer, so reviewerModel is recorded and the
		// combined inspection counts are runtime-sourced (at least the overview ran).
		expect(result.provenance.reviewerModel).toBeDefined();
		expect(result.provenance.inspectionCalls).toBeGreaterThan(0);
	}, 600_000);
});
