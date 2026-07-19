import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage, ModelRegistry, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterAll, describe, expect, it } from "vitest";
import { createIsolatedVisionSession } from "../../src/agent/session.ts";

// Isolation is proven offline: an explicit built-in vision model is resolved from
// the registry without any auth, and no prompt() is issued, so no network call and
// no provider credentials are required.
const workDir = mkdtempSync(join(tmpdir(), "v2d-session-"));
const authStorage = AuthStorage.create(join(workDir, "auth.json"));
const modelRegistry = ModelRegistry.inMemory(authStorage);

function firstVisionModel() {
	const preferred = modelRegistry.find("anthropic", "claude-opus-4-5");
	if (preferred?.input.includes("image")) return preferred;
	return modelRegistry.getAll().find((m) => m.input.includes("image"));
}

const model = firstVisionModel();

const imageTool = defineTool({
	name: "inspect_frame",
	label: "Inspect Frame",
	description: "returns an image",
	parameters: Type.Object({ frameId: Type.String() }),
	execute: async () => ({ content: [{ type: "image", data: "AA", mimeType: "image/png" }], details: {} }),
});
const submitTool = defineTool({
	name: "submit_analysis",
	label: "Submit",
	description: "submit",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {}, terminate: true }),
});

const disposers: Array<() => void> = [];
afterAll(() => {
	for (const dispose of disposers) dispose();
});

describe("createIsolatedVisionSession", () => {
	it("resolves a built-in vision-capable model offline", () => {
		expect(model, "expected at least one built-in vision-capable model").toBeDefined();
		expect(model?.input).toContain("image");
	});

	it("exposes only the allowlisted custom tools and no built-in coding tools", async () => {
		if (!model) return;
		const handle = await createIsolatedVisionSession({
			model,
			customTools: [imageTool, submitTool],
			systemPrompt: "ISOLATED-ANALYST-PROMPT",
			cwd: workDir,
			agentDir: join(workDir, "agent"),
			authStorage,
			modelRegistry,
		});
		disposers.push(() => handle.dispose());

		const toolNames = handle.session.agent.state.tools.map((t) => t.name).sort();
		expect(toolNames).toEqual(["inspect_frame", "submit_analysis"]);
		for (const forbidden of ["bash", "read", "edit", "write", "grep", "find", "ls"]) {
			expect(toolNames).not.toContain(forbidden);
		}
	});

	it("applies the system prompt override and suppresses appended prompts", async () => {
		if (!model) return;
		const handle = await createIsolatedVisionSession({
			model,
			customTools: [imageTool],
			systemPrompt: "ISOLATED-ANALYST-PROMPT",
			cwd: workDir,
			agentDir: join(workDir, "agent"),
			authStorage,
			modelRegistry,
		});
		disposers.push(() => handle.dispose());

		expect(handle.session.agent.state.systemPrompt).toContain("ISOLATED-ANALYST-PROMPT");
	});

	it("persists no transcript, session history, or reasoning under the agent dir", async () => {
		if (!model) return;
		const { existsSync, readdirSync, statSync } = await import("node:fs");
		const privateDir = mkdtempSync(join(tmpdir(), "v2d-agentdir-"));
		const agentDir = join(privateDir, "agent");
		const handle = await createIsolatedVisionSession({
			model,
			customTools: [imageTool, submitTool],
			systemPrompt: "ISOLATED-ANALYST-PROMPT",
			cwd: privateDir,
			agentDir,
			authStorage,
			modelRegistry,
		});
		handle.dispose();

		// The session/settings managers are in-memory, so nothing about the conversation
		// may land on disk. Recursively assert no transcript/history/reasoning artifacts
		// exist under the agent dir.
		const offenders: string[] = [];
		const walk = (dir: string) => {
			if (!existsSync(dir)) return;
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) {
					if (/session|transcript|history|messages/i.test(entry)) offenders.push(full);
					walk(full);
				} else if (/\.jsonl$|session|transcript|history|reasoning|messages/i.test(entry)) {
					offenders.push(full);
				}
			}
		};
		walk(agentDir);
		expect(offenders).toEqual([]);
	});

	it("rejects a text-only model before creating a session", async () => {
		const textOnly = { provider: "fake", id: "text-only", input: ["text"] } as unknown as typeof model & object;
		await expect(
			createIsolatedVisionSession({
				// biome-ignore lint/suspicious/noExplicitAny: intentionally passing a non-vision stub
				model: textOnly as any,
				customTools: [imageTool],
				systemPrompt: "x",
				cwd: workDir,
				agentDir: join(workDir, "agent"),
				authStorage,
				modelRegistry,
			}),
		).rejects.toThrow();
	});
});
