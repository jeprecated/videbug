/**
 * Regression: the CLI entry-point guard must fire when the executable is invoked
 * through a symlink (the normal `node_modules/.bin/videbug` install path),
 * not only when `dist/cli.js` is run directly. A naive `import.meta.url ===
 * "file://" + process.argv[1]` check silently no-ops on the symlinked bin path,
 * so `--version`/`--help` produce no output.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { isMainModule } from "../../src/cli.ts";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const distCli = join(projectRoot, "dist", "cli.js");

// Build the real executable so the subprocess assertions exercise the shipped
// entry-point guard, not the TypeScript source.
beforeAll(() => {
	execFileSync("npm", ["run", "build"], { cwd: projectRoot, stdio: "ignore" });
}, 60_000);

function versionOf(entry: string): { stdout: string; code: number } {
	try {
		const stdout = execFileSync(process.execPath, [entry, "--version"], { encoding: "utf8" });
		return { stdout, code: 0 };
	} catch (error) {
		const e = error as { stdout?: string; status?: number };
		return { stdout: e.stdout ?? "", code: e.status ?? 1 };
	}
}

describe("cli entry-point guard (subprocess)", () => {
	it("runs main() when dist/cli.js is executed directly", () => {
		const { stdout } = versionOf(distCli);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it.each(["videbug", "video-to-debug"])("runs main() through the installed %s bin symlink", (binName) => {
		const dir = mkdtempSync(join(tmpdir(), "videbug-bin-"));
		const linked = join(dir, binName);
		symlinkSync(distCli, linked);
		const { stdout } = versionOf(linked);
		expect(stdout.trim(), "CLI produced no output when invoked via a symlink").toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe("isMainModule", () => {
	it("matches when the entry path is a symlink to the module realpath", () => {
		const dir = mkdtempSync(join(tmpdir(), "videbug-guard-"));
		const real = join(dir, "cli.js");
		writeFileSync(real, "");
		const link = join(dir, "bin-link");
		symlinkSync(real, link);
		const moduleUrl = pathToFileURL(real).href;

		expect(isMainModule(moduleUrl, link)).toBe(true);
		expect(isMainModule(moduleUrl, real)).toBe(true);
	});

	it("does not match an unrelated entry path", () => {
		const dir = mkdtempSync(join(tmpdir(), "videbug-guard-"));
		const real = join(dir, "cli.js");
		const other = join(dir, "other.js");
		writeFileSync(real, "");
		writeFileSync(other, "");
		expect(isMainModule(pathToFileURL(real).href, other)).toBe(false);
	});

	it("returns false when there is no entry path (imported as a module)", () => {
		expect(isMainModule("file:///nowhere/cli.js", undefined)).toBe(false);
	});
});
