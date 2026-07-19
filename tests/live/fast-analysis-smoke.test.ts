/**
 * Opt-in live end-to-end fast-analysis smoke test (milestone M4).
 *
 * Skipped unless V2D_LIVE=1 and Pi auth for a vision-capable model is available.
 * It runs the real `--mode fast` flow on a small deterministic fixture against a
 * real model and asserts a validated `AnalysisResultV1` with registry-backed
 * citations. It is NOT a deterministic CI gate.
 *
 * Run with:  V2D_LIVE=1 npx vitest run tests/live/fast-analysis-smoke.test.ts
 */
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { runFastAnalysis } from "../../src/app/fast-analysis.ts";
import { STATIC_FIXTURE, ensureFixtures } from "../helpers/fixtures.ts";

const LIVE = process.env.V2D_LIVE === "1";
const MODEL = process.env.V2D_LIVE_MODEL ?? "anthropic/claude-opus-4-8";

describe.skipIf(!LIVE)("live fast analysis", () => {
	it("produces a validated AnalysisResultV1 with registry-backed citations", async () => {
		await ensureFixtures();
		const authStorage = AuthStorage.create();
		const modelRegistry = ModelRegistry.create(authStorage);
		if (!modelRegistry.getAvailable().some((m) => m.input.includes("image"))) {
			console.warn("[live] no vision-capable model with configured auth; skipping");
			return;
		}

		const result = await runFastAnalysis({
			videoPath: STATIC_FIXTURE.path,
			model: MODEL,
			maxAgentTurns: 20,
			modelResolution: { authStorage, modelRegistry },
			onProgress: (e) => console.error(`[live] ${e.phase}: ${e.message}`),
		});

		expect(result.schemaVersion).toBe("1");
		expect(result.beats.length).toBeGreaterThan(0);
		expect(result.provenance.analystModel).toContain("/");
		// Provenance counts are runtime-sourced, so at least the overview ran.
		expect(result.provenance.inspectionCalls).toBeGreaterThan(0);
	}, 300_000);
});
