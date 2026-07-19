import { beforeAll, describe, expect, it } from "vitest";
import { run } from "../../src/cli.ts";
import { ExitCode } from "../../src/util/errors.ts";
import { CFR_FIXTURE, ensureFixtures } from "../helpers/fixtures.ts";

beforeAll(async () => {
	await ensureFixtures();
});

function fakeIo() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
		stdout: () => out.join(""),
		stderr: () => err.join(""),
	};
}

describe("--dry-run deterministic diagnostic", () => {
	it("runs the deterministic engine and emits a labeled JSON diagnostic to stdout (exit 0)", async () => {
		const { io, stdout, stderr } = fakeIo();
		const code = await run([CFR_FIXTURE.path, "--dry-run", "--quiet"], io);
		expect(code).toBe(ExitCode.Success);

		const parsed = JSON.parse(stdout());
		// Explicitly a diagnostic, never an AnalysisResultV1 "complete" analysis.
		expect(parsed.diagnostic).toBe("evidence-engine");
		expect(parsed.schemaVersion).toBeUndefined();
		expect(parsed.beats).toBeUndefined();
		expect(parsed.source.basename).toBe("cfr-10fps.mp4");
		expect(parsed.scan.frameCount).toBe(CFR_FIXTURE.frameCount);
		expect(parsed.signals.count).toBe(CFR_FIXTURE.frameCount);
		expect(typeof parsed.candidates.total).toBe("number");
		// --quiet suppresses progress chatter on stderr.
		expect(stderr()).toBe("");
	});

	it("emits phase progress to stderr when not quiet, keeping stdout pure JSON", async () => {
		const { io, stdout, stderr } = fakeIo();
		const code = await run([CFR_FIXTURE.path, "--dry-run"], io);
		expect(code).toBe(ExitCode.Success);
		expect(() => JSON.parse(stdout())).not.toThrow();
		expect(stderr().toLowerCase()).toMatch(/scan|probe|candidate/);
	});

	it("maps a missing/undecodable source to the ffmpeg failure exit code (3)", async () => {
		const { io, stdout } = fakeIo();
		const code = await run(["/nonexistent/does-not-exist.mp4", "--dry-run", "--quiet"], io);
		expect(code).toBe(ExitCode.FfmpegFailure);
		expect(stdout()).toBe("");
	});
});
