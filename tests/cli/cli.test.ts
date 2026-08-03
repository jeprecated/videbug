import { describe, expect, it } from "vitest";
import { HELP_TEXT, parseArgs, run } from "../../src/cli.ts";
import { ExitCode } from "../../src/util/errors.ts";

function fakeIo() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) },
		stdout: () => out.join(""),
		stderr: () => err.join(""),
	};
}

describe("parseArgs", () => {
	it("recognizes --help", () => {
		expect(parseArgs(["--help"]).kind).toBe("help");
		expect(parseArgs(["-h"]).kind).toBe("help");
	});

	it("recognizes --version", () => {
		expect(parseArgs(["--version"]).kind).toBe("version");
	});

	it("defaults to a Markdown report beside the video", () => {
		const parsed = parseArgs(["recording.mp4"]);
		expect(parsed.kind).toBe("run");
		if (parsed.kind === "run") {
			expect(parsed.options.video).toBe("recording.mp4");
			expect(parsed.options.format).toBe("markdown");
			expect(parsed.options.output).toBe("recording.videbug.md");
			expect(parsed.options.mode).toBe("standard");
			expect(parsed.options.quiet).toBe(false);
		}
	});

	it("uses the video directory and selected format for the default report path", () => {
		const parsed = parseArgs(["/captures/recording.final.mp4", "--format", "json"]);
		if (parsed.kind === "run") {
			expect(parsed.options.output).toBe("/captures/recording.final.videbug.json");
		}
	});

	it("supports explicit stdout output for agents and pipelines", () => {
		const parsed = parseArgs(["recording.mp4", "--stdout"]);
		if (parsed.kind === "run") expect(parsed.options.output).toBeUndefined();
	});

	it("rejects conflicting --stdout and --output destinations", () => {
		expect(() => parseArgs(["recording.mp4", "--stdout", "--output", "report.md"])).toThrow(
			/--stdout.*--output|--output.*--stdout/i,
		);
	});

	it("parses --timeout as a positive number of seconds", () => {
		const parsed = parseArgs(["recording.mp4", "--timeout", "30"]);
		if (parsed.kind === "run") expect(parsed.options.timeoutSeconds).toBe(30);
		expect(() => parseArgs(["recording.mp4", "--timeout", "0"])).toThrow(/timeout/i);
		expect(() => parseArgs(["recording.mp4", "--timeout", "nope"])).toThrow(/timeout/i);
	});

	it("parses flags in both --flag value and --flag=value forms", () => {
		const parsed = parseArgs([
			"recording.mp4",
			"--format",
			"json",
			"--mode=fast",
			"--output",
			"out.json",
			"--model",
			"anthropic/claude-opus-4-5",
			"--review-model=anthropic/claude-sonnet-4-5",
			"--max-agent-turns",
			"12",
			"--quiet",
		]);
		expect(parsed.kind).toBe("run");
		if (parsed.kind === "run") {
			expect(parsed.options.format).toBe("json");
			expect(parsed.options.mode).toBe("fast");
			expect(parsed.options.output).toBe("out.json");
			expect(parsed.options.model).toBe("anthropic/claude-opus-4-5");
			expect(parsed.options.reviewModel).toBe("anthropic/claude-sonnet-4-5");
			expect(parsed.options.maxAgentTurns).toBe(12);
			expect(parsed.options.quiet).toBe(true);
		}
	});

	it("accepts report guidance through --prompt", () => {
		const spaced = parseArgs(["recording.mp4", "--prompt", "  focus on the button-to-load transition  "]);
		if (spaced.kind === "run") expect(spaced.options.prompt).toBe("focus on the button-to-load transition");

		const inline = parseArgs(["recording.mp4", "--prompt=be concise"]);
		if (inline.kind === "run") expect(inline.options.prompt).toBe("be concise");

		expect(() => parseArgs(["recording.mp4", "--prompt="])).toThrow(/prompt.*non-empty/i);
	});

	it("parses the --dry-run diagnostic flag and keeps diagnostics on stdout", () => {
		const off = parseArgs(["recording.mp4"]);
		if (off.kind === "run") expect(off.options.dryRun ?? false).toBe(false);
		const on = parseArgs(["recording.mp4", "--dry-run"]);
		if (on.kind === "run") {
			expect(on.options.dryRun).toBe(true);
			expect(on.options.output).toBeUndefined();
		}
	});

	it("supports --keep-artifacts as a bare flag and with a directory", () => {
		const bare = parseArgs(["recording.mp4", "--keep-artifacts"]);
		if (bare.kind === "run") expect(bare.options.keepArtifacts).toBe(true);
		const dir = parseArgs(["recording.mp4", "--keep-artifacts=./art"]);
		if (dir.kind === "run") expect(dir.options.keepArtifacts).toBe("./art");
	});

	it("throws on a missing video", () => {
		expect(() => parseArgs([])).toThrow(/video/i);
	});

	it("throws on an unknown flag", () => {
		expect(() => parseArgs(["recording.mp4", "--nope"])).toThrow(/unknown/i);
	});

	it("throws on an invalid --format", () => {
		expect(() => parseArgs(["recording.mp4", "--format", "yaml"])).toThrow(/format/i);
	});

	it("throws on an invalid --mode", () => {
		expect(() => parseArgs(["recording.mp4", "--mode", "turbo"])).toThrow(/mode/i);
	});

	it("throws on a non-numeric --max-agent-turns", () => {
		expect(() => parseArgs(["recording.mp4", "--max-agent-turns", "lots"])).toThrow(/max-agent-turns/i);
	});

	it("throws on more than one positional video", () => {
		expect(() => parseArgs(["a.mp4", "b.mp4"])).toThrow(/one video|unexpected/i);
	});
});

describe("run stdout/stderr and exit contract", () => {
	it("prints help to stdout and exits 0, with nothing on stderr", async () => {
		const { io, stdout, stderr } = fakeIo();
		const code = await run(["--help"], io);
		expect(code).toBe(0);
		expect(stdout()).toContain("videbug");
		expect(stdout()).toBe(HELP_TEXT);
		expect(stderr()).toBe("");
	});

	it("help discloses that frames are sent to the model provider", async () => {
		expect(HELP_TEXT.toLowerCase()).toContain("provider");
		expect(HELP_TEXT.toLowerCase()).toMatch(/frame|image/);
	});

	it("prints a version to stdout and exits 0", async () => {
		const { io, stdout } = fakeIo();
		const code = await run(["--version"], io);
		expect(code).toBe(0);
		expect(stdout().trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("reports invalid arguments on stderr and exits 2 with empty stdout", async () => {
		const { io, stdout, stderr } = fakeIo();
		const code = await run(["--nope"], io);
		expect(code).toBe(ExitCode.InvalidArguments);
		expect(stdout()).toBe("");
		expect(stderr().toLowerCase()).toContain("unknown");
	});

	it("standard mode (default) fails on a nonexistent video without ever writing to stdout", async () => {
		// Standard mode is now wired (M5). With a nonexistent video it fails closed on
		// a documented path (model/auth exit 4 or ffmpeg exit 3, depending on ambient
		// Pi auth) and NEVER emits a fabricated report to stdout.
		const { io, stdout } = fakeIo();
		const code = await run(["/nonexistent/never-read.mp4"], io);
		expect(code).not.toBe(0);
		expect(stdout()).toBe("");
	});

	it("fast mode fails on a nonexistent video without writing to stdout", async () => {
		const { io, stdout } = fakeIo();
		const code = await run(["/nonexistent/never-read.mp4", "--mode", "fast"], io);
		expect(code).not.toBe(0);
		expect(stdout()).toBe("");
	});
});
