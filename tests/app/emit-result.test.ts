import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitResult, writeOutputFile } from "../../src/app/analyze-video.ts";
import type { CliOptions } from "../../src/cli.ts";
import type { AnalysisResultV1 } from "../../src/contracts/analysis-v1.ts";
import { BudgetExhaustedError } from "../../src/util/errors.ts";

function result(status: "complete" | "partial"): AnalysisResultV1 {
	return {
		schemaVersion: "1",
		status,
		coverage: {
			analyzedStartMs: 0,
			analyzedEndMs: status === "complete" ? 2000 : 1000,
			uninspectedRanges: status === "complete" ? [] : [{ startMs: 1000, endMs: 2000 }],
			confidence: "medium",
		},
		summary: { observedFailure: "x", chronology: "y" },
		beats: [],
		anomalies: [],
		handoff: { reproductionSteps: [], suggestedInvestigations: [], uncertainties: ["tail not inspected"] },
		source: {
			basename: "v.mp4",
			sha256: "a".repeat(64),
			durationMs: 2000,
			width: 64,
			height: 64,
			streamIndex: 0,
			averageFps: 10,
		},
		provenance: {
			toolVersion: "t",
			ffmpegVersion: "f",
			analystModel: "p/m",
			reviewerModel: "p/m",
			inspectionCalls: 1,
			inspectedCells: 1,
			fullResolutionFrames: 0,
		},
	};
}

function baseOptions(overrides: Partial<CliOptions> = {}): CliOptions {
	return { video: "v.mp4", format: "json", mode: "standard", quiet: true, ...overrides };
}

function fakeIo() {
	const out: string[] = [];
	const err: string[] = [];
	return { io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }, out, err };
}

describe("emitResult stdout/exit contract", () => {
	it("prints a complete result to stdout when no --output is given", async () => {
		const { io, out } = fakeIo();
		await emitResult(result("complete"), baseOptions(), io);
		expect(out.join("")).toContain("schemaVersion");
	});

	it("writes an output file atomically with user-only (0600) permissions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vtd-emit-"));
		const path = join(dir, "report.json");
		const { io } = fakeIo();
		await emitResult(result("complete"), baseOptions({ output: path }), io);
		const contents = readFileSync(path, "utf8");
		expect(contents).toContain("schemaVersion");
		const mode = statSync(path).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("writes to a hostile credential-like output path without echoing it to progress", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vtd-emit-"));
		const secret = "provider-token=sk-visible-secret";
		const path = join(dir, `${secret}.json`);
		const { io, err } = fakeIo();
		await emitResult(result("complete"), baseOptions({ output: path, quiet: false }), io);
		expect(readFileSync(path, "utf8")).toContain("schemaVersion");
		expect(err.join("")).toBe("report written to the requested output path\n");
		expect(err.join("")).not.toContain(path);
		expect(err.join("")).not.toContain(secret);
	});

	it("fails closed (exit 5) for a partial result and never prints it to stdout", async () => {
		const { io, out, err } = fakeIo();
		const error = await emitResult(result("partial"), baseOptions({ quiet: false }), io).catch((e) => e);
		expect(error).toBeInstanceOf(BudgetExhaustedError);
		expect((error as BudgetExhaustedError).exitCode).toBe(5);
		expect(out.join("")).toBe("");
		expect(err.join("")).toMatch(/partial|incomplete/i);
	});

	it("still writes the validated partial report without echoing its hostile --output path before exiting 5", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vtd-emit-"));
		const secret = "aws-secret-access-key=visible-secret";
		const path = join(dir, `${secret}.json`);
		const { io, err } = fakeIo();
		const error = await emitResult(result("partial"), baseOptions({ output: path, quiet: false }), io).catch((e) => e);
		expect(error).toBeInstanceOf(BudgetExhaustedError);
		expect(readFileSync(path, "utf8")).toContain('"status": "partial"');
		expect(err.join("")).toBe("partial report written to the requested output path (inspection incomplete)\n");
		expect(err.join("")).not.toContain(path);
		expect(err.join("")).not.toContain(secret);
	});
});

describe("writeOutputFile", () => {
	it("replaces an existing file atomically without leaving a temp file behind", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vtd-emit-"));
		const path = join(dir, "r.md");
		await writeOutputFile(path, "first");
		await writeOutputFile(path, "second");
		expect(readFileSync(path, "utf8")).toBe("second");
		const { readdirSync } = await import("node:fs");
		expect(readdirSync(dir)).toEqual(["r.md"]);
	});

	it("cleans up the temp file and redacts a hostile target path when rename fails", async () => {
		const { mkdirSync, readdirSync, writeFileSync } = await import("node:fs");
		const dir = mkdtempSync(join(tmpdir(), "vtd-emit-"));
		const secret = "secret-token=must-not-leak";
		// The target path is a NON-EMPTY directory, so rename(tmp, path) fails; the
		// private temp file must not be left behind and the outward error must not
		// render the caller-provided path embedded by Node.
		const target = join(dir, secret);
		mkdirSync(target);
		writeFileSync(join(target, "keep"), "x");
		const error = await writeOutputFile(target, "payload").catch((caught) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Unable to write the requested output.");
		expect((error as Error).message).not.toContain(secret);
		expect((error as Error).message).not.toContain(target);
		expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
		// Only the directory (and its child) remain — no leaked ".tmp-" sibling.
		expect(readdirSync(dir)).toEqual([secret]);
	});
});
