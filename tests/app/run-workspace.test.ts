import { existsSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRunWorkspace, withRunWorkspace } from "../../src/app/run-workspace.ts";

describe("createRunWorkspace", () => {
	it("creates a private (0700) directory", async () => {
		const ws = await createRunWorkspace();
		try {
			expect(existsSync(ws.dir)).toBe(true);
			const mode = statSync(ws.dir).mode & 0o777;
			expect(mode).toBe(0o700);
		} finally {
			await ws.cleanup();
		}
	});

	it("resolves child paths under the workspace root", async () => {
		const ws = await createRunWorkspace();
		try {
			expect(ws.path("frames", "a.png")).toBe(`${ws.dir}/frames/a.png`);
		} finally {
			await ws.cleanup();
		}
	});

	it("cleanup removes the directory and all contents, and is idempotent", async () => {
		const ws = await createRunWorkspace();
		writeFileSync(ws.path("scratch.txt"), "data");
		await ws.cleanup();
		expect(existsSync(ws.dir)).toBe(false);
		// Second cleanup must not throw.
		await expect(ws.cleanup()).resolves.toBeUndefined();
	});
});

describe("withRunWorkspace", () => {
	it("cleans up after a successful run", async () => {
		let captured = "";
		const result = await withRunWorkspace(async (ws) => {
			captured = ws.dir;
			return 42;
		});
		expect(result).toBe(42);
		expect(existsSync(captured)).toBe(false);
	});

	it("cleans up even when the run throws (fail-safe on cancellation/error)", async () => {
		let captured = "";
		await expect(
			withRunWorkspace(async (ws) => {
				captured = ws.dir;
				writeFileSync(ws.path("partial.bin"), "x");
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(existsSync(captured)).toBe(false);
	});
});
