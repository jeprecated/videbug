import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { runFastAnalysis } from "../../src/app/fast-analysis.ts";
import { PiUnavailableError } from "../../src/util/errors.ts";

// These tests exercise the fast-mode fail-closed model/auth gates deterministically:
// they never reach a provider call. An in-memory registry has no configured auth,
// so a resolvable vision model is still rejected by the auth gate before the
// engine runs. A real end-to-end fast run is covered by the opt-in live path.
const authStorage = AuthStorage.create(join(mkdtempSync(join(tmpdir(), "vtd-fast-")), "auth.json"));
const modelRegistry = ModelRegistry.inMemory(authStorage);

describe("runFastAnalysis fail-closed gates", () => {
	// Note: default-model resolution (true one-call, no --model) is unit-tested in
	// tests/agent/model-resolution.test.ts with stub registries; here we exercise
	// the explicit-model auth/vision gates against a resolvable model.
	it("fails closed (exit 4) when the resolved model has no configured auth, before touching the video", async () => {
		const error = await runFastAnalysis({
			videoPath: "/nonexistent/never-read.mp4",
			model: "anthropic/claude-opus-4-8",
			modelResolution: { authStorage, modelRegistry },
		}).catch((e) => e);
		expect(error).toBeInstanceOf(PiUnavailableError);
		expect((error as PiUnavailableError).exitCode).toBe(4);
	});

	it("fails closed (exit 4) for a text-only model", async () => {
		const textOnly = modelRegistry.getAll().find((m) => !m.input.includes("image"));
		expect(textOnly).toBeDefined();
		const error = await runFastAnalysis({
			videoPath: "/nonexistent/never-read.mp4",
			model: `${textOnly!.provider}/${textOnly!.id}`,
			modelResolution: { authStorage, modelRegistry },
		}).catch((e) => e);
		expect(error).toBeInstanceOf(PiUnavailableError);
		expect((error as PiUnavailableError).exitCode).toBe(4);
		expect((error as Error).message).toMatch(/image/i);
	});
});
