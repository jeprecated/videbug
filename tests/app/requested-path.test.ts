import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFastAnalysis } from "../../src/app/fast-analysis.ts";
import {
	RequestedPathError,
	sanitizeRequestedArtifactsFailure,
	writeRequestedArtifact,
} from "../../src/app/requested-path.ts";
import { runStandardAnalysis } from "../../src/app/standard-analysis.ts";

function hostileFilePath(): { path: string; secret: string } {
	const dir = mkdtempSync(join(tmpdir(), "vtd-requested-path-"));
	const secret = "provider-key=sk-must-not-leak";
	const path = join(dir, secret);
	writeFileSync(path, "not a directory");
	return { path, secret };
}

async function capture(promise: Promise<unknown>): Promise<Error> {
	const error = await promise.catch((caught) => caught);
	expect(error).toBeInstanceOf(RequestedPathError);
	return error as Error;
}

function expectRedacted(error: Error, path: string, secret: string, expected: string): void {
	expect(error.message).toBe(expected);
	expect(error.message).not.toContain(path);
	expect(error.message).not.toContain(secret);
	expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
}

describe("requested artifact path failures", () => {
	it("redacts an invalid --keep-artifacts path before fast mode can resolve a model", async () => {
		const { path, secret } = hostileFilePath();
		const error = await capture(runFastAnalysis({ videoPath: "unused.mp4", keepArtifactsDir: path }));
		expectRedacted(error, path, secret, "Unable to create the requested artifacts directory.");
	});

	it("redacts an invalid --keep-artifacts path before standard mode can resolve models", async () => {
		const { path, secret } = hostileFilePath();
		const error = await capture(runStandardAnalysis({ videoPath: "unused.mp4", keepArtifactsDir: path }));
		expectRedacted(error, path, secret, "Unable to create the requested artifacts directory.");
	});

	it("redacts requested artifact manifest write failures", async () => {
		const dir = mkdtempSync(join(tmpdir(), "vtd-requested-path-"));
		const secret = "credential=must-not-leak";
		const target = join(dir, secret);
		mkdirSync(target);
		const error = await capture(writeRequestedArtifact(target, "payload"));
		expectRedacted(error, target, secret, "Unable to write requested analysis artifacts.");
	});

	it("redacts extraction errors that contain a requested artifact path without masking unrelated errors", () => {
		const dir = "/tmp/private-token=must-not-leak";
		const raw = new Error(`ffmpeg failed writing ${dir}/evidence/frame.png`);
		const sanitized = sanitizeRequestedArtifactsFailure(raw, dir);
		expect(sanitized).toBeInstanceOf(RequestedPathError);
		expect((sanitized as Error).message).toBe("Unable to use the requested artifacts directory.");
		expect((sanitized as Error).message).not.toContain("private-token");

		const unrelated = new Error("model unavailable");
		expect(sanitizeRequestedArtifactsFailure(unrelated, dir)).toBe(unrelated);
	});
});
