#!/usr/bin/env node
/**
 * videbug CLI.
 *
 * Argument parsing, `--help`/`--version`, and the stdout/stderr/exit-code contract
 * from implementation plan §4. Parsing is a pure function (`parseArgs`) and the
 * run loop is I/O-injected (`run`) so both are directly unit-testable without
 * touching the real process. Diagnostics go to stderr; the final validated report
 * goes to a sibling file by default, an explicit `--output`, or `--stdout`. A valid invocation runs the full analysis
 * pipeline (probe -> deterministic evidence engine -> constrained vision analyst
 * -> independent reviewer -> validation -> render) via `analyzeVideo`, or fails
 * closed with a typed error and a non-zero exit code rather than fabricating output.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeVideo } from "./app/analyze-video.ts";
import { createRunCancellation } from "./util/cancellation.ts";
import { AppError, InvalidArgumentsError, resolveExitCode } from "./util/errors.ts";

export type OutputFormat = "markdown" | "json";
export type RunMode = "standard" | "fast";

export interface CliOptions {
	video: string;
	format: OutputFormat;
	output?: string;
	model?: string;
	reviewModel?: string;
	mode: RunMode;
	maxAgentTurns?: number;
	/** Wall-clock process timeout in seconds; aborts the run and cleans up. */
	timeoutSeconds?: number;
	keepArtifacts?: boolean | string;
	quiet: boolean;
	/**
	 * Diagnostic mode: run only the deterministic evidence engine (probe, scan,
	 * signals, candidates) and print a labeled JSON diagnostic. Never runs Pi and
	 * never emits an `AnalysisResultV1`.
	 */
	dryRun?: boolean;
}

export type ParsedCli = { kind: "help" } | { kind: "version" } | { kind: "run"; options: CliOptions };

export interface CliIo {
	stdout(chunk: string): void;
	stderr(chunk: string): void;
	/** External cancellation (SIGINT / timeout), forwarded to the pipeline. */
	signal?: AbortSignal;
	/** Register an interrupt (SIGINT) handler; returns an unregister function. */
	onInterrupt?: (handler: () => void) => () => void;
}

function readVersion(): string {
	const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
	return JSON.parse(readFileSync(pkgPath, "utf8")).version as string;
}

const VERSION = readVersion();

export const HELP_TEXT = `videbug ${VERSION}

Turn a screen recording into a validated, evidence-backed debugging handoff using
an embedded Pi vision agent.

Usage:
  videbug <video> [options]

Options:
  --format markdown|json          Output format (default: markdown)
  --output <path>                 Write the report to an explicit path
  --stdout                        Print the report to stdout instead of a sibling file
  --model <provider/model[:think]>   Analyst model (default: your Pi default)
  --review-model <provider/model[:think]>  Reviewer model (default: analyst model)
  --mode standard|fast            standard = analyst + independent reviewer;
                                  fast = analyst only (default: standard)
  --max-agent-turns <n>           Cap agent turns per session
  --timeout <seconds>             Abort the whole run after N seconds (cleans up)
  --keep-artifacts [<directory>]  Preserve evidence/manifests (default: discarded)
  --dry-run                       Diagnostic: run only the deterministic evidence
                                  engine and print a JSON diagnostic (no model)
  --quiet                         Suppress progress output on stderr
  -h, --help                      Show this help
  --version                       Show the version

Privacy:
  Selected video frames are extracted and sent as images to the configured model
  provider. The full video is never uploaded. Temporary artifacts are created with
  user-only permissions and deleted on exit unless --keep-artifacts is given.

Exit codes:
  0  complete, validated analysis
  2  invalid arguments or unsupported input
  3  ffmpeg/ffprobe/probing/extraction failure
  4  Pi auth/model unavailable or model lacks image support
  5  validated structured partial after an inspection constraint (file output only)
  6  agent failed to submit a valid result
  7  reviewer rejected the result without a valid replacement
`;

const FORMATS: readonly OutputFormat[] = ["markdown", "json"];
const MODES: readonly RunMode[] = ["standard", "fast"];

interface Token {
	flag: string;
	inlineValue?: string;
}

function splitFlag(arg: string): Token {
	const eq = arg.indexOf("=");
	if (eq === -1) return { flag: arg };
	return { flag: arg.slice(0, eq), inlineValue: arg.slice(eq + 1) };
}

export function parseArgs(argv: string[]): ParsedCli {
	if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
	if (argv.includes("--version")) return { kind: "version" };

	const positionals: string[] = [];
	let format: OutputFormat = "markdown";
	let mode: RunMode = "standard";
	let quiet = false;
	let output: string | undefined;
	let stdout = false;
	let model: string | undefined;
	let reviewModel: string | undefined;
	let maxAgentTurns: number | undefined;
	let timeoutSeconds: number | undefined;
	let keepArtifacts: boolean | string | undefined;
	let dryRun = false;

	// Consume a value for a flag, from the inline `--flag=value` form or the next
	// argv token. Throws if neither is present.
	let i = 0;
	const takeValue = (token: Token): string => {
		if (token.inlineValue !== undefined) return token.inlineValue;
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			throw new InvalidArgumentsError(`Option ${token.flag} requires a value.`);
		}
		i += 1;
		return next;
	};

	for (; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith("-")) {
			positionals.push(arg);
			continue;
		}
		const token = splitFlag(arg);
		switch (token.flag) {
			case "--format": {
				const value = takeValue(token);
				if (!FORMATS.includes(value as OutputFormat)) {
					throw new InvalidArgumentsError(`Invalid --format ${JSON.stringify(value)}; expected markdown or json.`);
				}
				format = value as OutputFormat;
				break;
			}
			case "--mode": {
				const value = takeValue(token);
				if (!MODES.includes(value as RunMode)) {
					throw new InvalidArgumentsError(`Invalid --mode ${JSON.stringify(value)}; expected standard or fast.`);
				}
				mode = value as RunMode;
				break;
			}
			case "--output":
				output = takeValue(token);
				break;
			case "--stdout":
				stdout = true;
				break;
			case "--model":
				model = takeValue(token);
				break;
			case "--review-model":
				reviewModel = takeValue(token);
				break;
			case "--max-agent-turns": {
				const value = takeValue(token);
				const n = Number(value);
				if (!Number.isInteger(n) || n <= 0) {
					throw new InvalidArgumentsError(
						`Invalid --max-agent-turns ${JSON.stringify(value)}; expected a positive integer.`,
					);
				}
				maxAgentTurns = n;
				break;
			}
			case "--timeout": {
				const value = takeValue(token);
				const n = Number(value);
				if (!Number.isFinite(n) || n <= 0) {
					throw new InvalidArgumentsError(
						`Invalid --timeout ${JSON.stringify(value)}; expected a positive number of seconds.`,
					);
				}
				timeoutSeconds = n;
				break;
			}
			case "--keep-artifacts":
				keepArtifacts = token.inlineValue !== undefined ? token.inlineValue : true;
				break;
			case "--dry-run":
				dryRun = true;
				break;
			case "--quiet":
				quiet = true;
				break;
			default:
				throw new InvalidArgumentsError(`Unknown option ${token.flag}.`);
		}
	}

	if (positionals.length === 0) {
		throw new InvalidArgumentsError("Missing <video>. Usage: videbug <video> [options]. See --help.");
	}
	if (positionals.length > 1) {
		throw new InvalidArgumentsError(
			`Expected exactly one video, got ${positionals.length}: ${positionals.join(", ")}. See --help.`,
		);
	}
	if (stdout && output !== undefined) {
		throw new InvalidArgumentsError("Options --stdout and --output cannot be used together.");
	}

	const video = positionals[0]!;
	const options: CliOptions = { video, format, mode, quiet };
	if (!dryRun && !stdout) options.output = output ?? defaultOutputPath(video, format);
	if (model !== undefined) options.model = model;
	if (reviewModel !== undefined) options.reviewModel = reviewModel;
	if (maxAgentTurns !== undefined) options.maxAgentTurns = maxAgentTurns;
	if (timeoutSeconds !== undefined) options.timeoutSeconds = timeoutSeconds;
	if (keepArtifacts !== undefined) options.keepArtifacts = keepArtifacts;
	if (dryRun) options.dryRun = true;

	return { kind: "run", options };
}

/** Derive the default report path beside the source video. */
export function defaultOutputPath(video: string, format: OutputFormat): string {
	const { dir, name } = parsePath(video);
	const extension = format === "json" ? "json" : "md";
	return join(dir, `${name}.videbug.${extension}`);
}

export async function run(argv: string[], io: CliIo): Promise<number> {
	let parsed: ParsedCli;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		io.stderr(`${errorMessage(error)}\n`);
		return resolveExitCode(error);
	}

	if (parsed.kind === "help") {
		io.stdout(HELP_TEXT);
		return 0;
	}
	if (parsed.kind === "version") {
		io.stdout(`${VERSION}\n`);
		return 0;
	}

	const cancellation = createRunCancellation({
		...(parsed.options.timeoutSeconds !== undefined ? { timeoutMs: parsed.options.timeoutSeconds * 1000 } : {}),
		...(io.onInterrupt ? { onInterrupt: io.onInterrupt } : {}),
	});
	const runIo = { ...io, signal: io.signal ?? cancellation.signal };
	try {
		await analyzeVideo(parsed.options, runIo);
		return 0;
	} catch (error) {
		if (cancellation.signal.aborted) {
			io.stderr(`error: run aborted (${cancellation.reason() ?? "cancelled"})\n`);
			return resolveExitCode(error);
		}
		io.stderr(`${errorMessage(error)}\n`);
		return resolveExitCode(error);
	} finally {
		cancellation.dispose();
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof AppError) return `error: ${error.message}`;
	if (error instanceof Error) return `error: ${error.message}`;
	return `error: ${String(error)}`;
}

async function main(): Promise<void> {
	const code = await run(process.argv.slice(2), {
		stdout: (chunk) => process.stdout.write(chunk),
		stderr: (chunk) => process.stderr.write(chunk),
		// SIGINT (Ctrl-C) aborts the run; the flow cleans up the private workspace and
		// kills ffmpeg children via the forwarded AbortSignal before exiting.
		onInterrupt: (handler) => {
			process.on("SIGINT", handler);
			return () => process.off("SIGINT", handler);
		},
	});
	process.exitCode = code;
}

/**
 * True when this module is the process entry point, robust to symlinked bin paths.
 *
 * Node resolves `import.meta.url` to the module's realpath, but `process.argv[1]`
 * is the path exactly as invoked — which for a normal npm install is the
 * `node_modules/.bin/videbug` symlink, not the real `dist/cli.js`. A raw
 * string comparison (`import.meta.url === "file://" + process.argv[1]`) therefore
 * silently fails on the standard installed-CLI path and `main()` never runs.
 * Resolve both sides through `realpathSync` and `pathToFileURL` (which also encodes
 * spaces/special characters correctly) before comparing.
 */
export function isMainModule(moduleUrl: string, entryPath: string | undefined): boolean {
	if (!entryPath) return false;
	try {
		const entryHref = pathToFileURL(realpathSync(entryPath)).href;
		const moduleHref = pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href;
		return entryHref === moduleHref;
	} catch {
		return false;
	}
}

// Only run when executed directly (including via a symlinked bin), not when
// imported by tests.
if (isMainModule(import.meta.url, process.argv[1])) {
	void main();
}
