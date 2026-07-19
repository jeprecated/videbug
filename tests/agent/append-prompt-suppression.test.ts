/**
 * Negative proof that the isolated session suppresses unrelated append prompts.
 *
 * The Pi SDK's `DefaultResourceLoader` discovers a global append prompt from
 * `<agentDir>/APPEND_SYSTEM.md` and composes it into the agent's system prompt. A
 * user's or project's append prompt must NOT leak into the analysis session.
 *
 * This test seeds a real `APPEND_SYSTEM.md` sentinel and proves, negatively, that:
 *   1. (positive control) an unguarded loader over the same agentDir DOES surface
 *      the sentinel — so it is a genuine contamination vector; and
 *   2. `createIsolatedVisionSession` (which sets `appendSystemPromptOverride: () => []`)
 *      produces a system prompt that does NOT contain the sentinel.
 *
 * Runs fully offline against a built-in in-memory vision model (no auth, no
 * network, no prompt()).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, DefaultResourceLoader, ModelRegistry, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, describe, expect, it } from "vitest";
import { createIsolatedVisionSession } from "../../src/agent/session.ts";

const SENTINEL = "SENTINEL-APPENDED-USER-PROMPT-MUST-NOT-LEAK";

const workDir = mkdtempSync(join(tmpdir(), "v2d-append-"));
const agentDir = join(workDir, "agent");
mkdirSync(agentDir, { recursive: true });
// A global append prompt a user/project might have configured.
writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), SENTINEL);

const authStorage = AuthStorage.create(join(workDir, "auth.json"));
const modelRegistry = ModelRegistry.inMemory(authStorage);
const model = modelRegistry.getAll().find((m) => m.input.includes("image"));

const imageTool = defineTool({
	name: "inspect_frame",
	label: "Inspect Frame",
	description: "returns an image",
	parameters: Type.Object({ frameId: Type.String() }),
	execute: async () => ({ content: [{ type: "image", data: "AA", mimeType: "image/png" }], details: {} }),
});

const disposers: Array<() => void> = [];
afterAll(() => {
	for (const dispose of disposers) dispose();
});

describe("append-prompt suppression", () => {
	it("positive control: an unguarded resource loader surfaces the append sentinel", async () => {
		const loader = new DefaultResourceLoader({ cwd: workDir, agentDir });
		await loader.reload();
		expect(loader.getAppendSystemPrompt().join("\n")).toContain(SENTINEL);
	});

	it("the isolated session drops the append sentinel from the composed system prompt", async () => {
		expect(model, "expected a built-in vision-capable model").toBeDefined();
		if (!model) return;
		const handle = await createIsolatedVisionSession({
			model,
			customTools: [imageTool],
			systemPrompt: "ISOLATED-ANALYST-PROMPT",
			cwd: workDir,
			agentDir,
			authStorage,
			modelRegistry,
		});
		disposers.push(() => handle.dispose());

		const systemPrompt = handle.session.agent.state.systemPrompt;
		expect(systemPrompt).toContain("ISOLATED-ANALYST-PROMPT");
		expect(systemPrompt).not.toContain(SENTINEL);
	});
});
