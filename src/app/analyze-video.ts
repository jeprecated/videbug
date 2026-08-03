/**
 * Top-level analysis entry point.
 *
 * `--mode standard` (default, M5) runs the full one-call flow: deterministic
 * evidence engine (M2) + constrained inspection tools (M3) + an isolated Pi analyst
 * (M4) + a genuinely fresh independent Pi reviewer (M5), and emits only the final
 * validated `AnalysisResultV1` to its selected file/stdout destination with progress
 * on stderr.
 *
 * `--mode fast` runs the analyst-only flow (no reviewer) as an explicit cost/latency
 * trade-off, keeping every deterministic guarantee.
 *
 * `--dry-run` runs only the deterministic phases (probe, scan, signals, candidates)
 * and prints a labeled JSON diagnostic to stdout. It never calls Pi.
 *
 * Cancellation: a wall-clock timeout and SIGINT are wired through an `AbortSignal`
 * to the session and every ffmpeg child, and the private workspace is always
 * cleaned up. If an agent successfully submits a validated structured partial after
 * an actual inspection constraint, exit 5 writes it only to a file destination; provider,
 * timeout, turn, and cancellation failures normally abort without a partial payload.
 */
import { chmodSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import type { CliOptions } from "../cli.ts";
import type { AnalysisResultV1 } from "../contracts/analysis-v1.ts";
import { renderJson } from "../output/json.ts";
import { renderMarkdown } from "../output/markdown.ts";
import { AppError, BudgetExhaustedError, FfmpegFailureError } from "../util/errors.ts";
import { ExtractionError } from "../video/extract.ts";
import { FfmpegError } from "../video/ffmpeg.ts";
import { FrameCatalogError } from "../video/probe.ts";
import { ScanError } from "../video/scan.ts";
import { runEvidenceEngine, summarizeEngineResult } from "./evidence-engine.ts";
import { runFastAnalysis } from "./fast-analysis.ts";
import { RequestedPathError } from "./requested-path.ts";
import { runStandardAnalysis } from "./standard-analysis.ts";

export interface AnalyzeIo {
	stdout(chunk: string): void;
	stderr(chunk: string): void;
	/** External cancellation (SIGINT / process timeout), forwarded to the pipeline. */
	signal?: AbortSignal;
}

/** Map deterministic video-engine failures onto the documented exit-code contract. */
function toAppError(error: unknown): unknown {
	if (error instanceof AppError) return error;
	if (
		error instanceof FfmpegError ||
		error instanceof FrameCatalogError ||
		error instanceof ScanError ||
		error instanceof ExtractionError
	) {
		return new FfmpegFailureError(error.message, error);
	}
	return error;
}

async function runDryRun(options: CliOptions, io: AnalyzeIo): Promise<void> {
	try {
		const result = await runEvidenceEngine(options.video, {
			...(io.signal ? { signal: io.signal } : {}),
			onProgress: (event) => {
				if (!options.quiet) io.stderr(`[${event.phase}] ${event.message}\n`);
			},
		});
		io.stdout(`${JSON.stringify(summarizeEngineResult(result), null, 2)}\n`);
	} catch (error) {
		throw toAppError(error);
	}
}

function renderResult(result: AnalysisResultV1, format: CliOptions["format"]): string {
	return format === "json" ? renderJson(result) : renderMarkdown(result);
}

/**
 * Resolve the `--keep-artifacts` option to a directory, or `undefined` when
 * artifacts should be discarded. A bare flag preserves into a timestamped
 * directory under the current working directory.
 */
function resolveKeepArtifactsDir(keepArtifacts: CliOptions["keepArtifacts"]): string | undefined {
	if (keepArtifacts === undefined || keepArtifacts === false) return undefined;
	if (typeof keepArtifacts === "string") return keepArtifacts;
	return `videbug-artifacts-${Date.now()}`;
}

/**
 * Write the report to a file atomically and privately: write to a sibling temp
 * file with user-only (0600) permissions, then rename over the target so a reader
 * never sees a half-written report and the report never lands world-readable.
 */
export async function writeOutputFile(path: string, rendered: string): Promise<void> {
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		await writeFile(tmp, rendered, { encoding: "utf8", mode: 0o600 });
		try {
			chmodSync(tmp, 0o600);
		} catch {
			// best effort on platforms without chmod semantics
		}
		await rename(tmp, path);
	} catch (error) {
		// Never leak the private (0600) temp file if the write, chmod, or rename fails
		// (e.g. rename over a non-empty directory, cross-device, or a full disk).
		await rm(tmp, { force: true }).catch(() => {});
		// Node filesystem messages embed the caller-provided path. Keep that raw error
		// only as a non-rendered cause so CLI stderr cannot disclose a hostile path.
		throw new RequestedPathError("Unable to write the requested output.", error);
	}
}

export async function emitResult(result: AnalysisResultV1, options: CliOptions, io: AnalyzeIo): Promise<void> {
	const rendered = renderResult(result, options.format);

	// A partial result must never be silently presented on stdout as if complete.
	// It is written when a file destination is selected (the CLI default or --output),
	// and the run exits 5 (validated structured coverage is incomplete) either way.
	if (result.status === "partial") {
		if (options.output) {
			await writeOutputFile(options.output, rendered);
			if (!options.quiet) io.stderr("partial report written to the requested output path (inspection incomplete)\n");
		} else if (!options.quiet) {
			io.stderr(
				"inspection incomplete: a validated partial result was submitted. Re-run without --stdout (or use --output <path>) to save a future partial and inspect coverage.uninspectedRanges. Not printing a partial result to stdout.\n",
			);
		}
		throw new BudgetExhaustedError("Coverage is incomplete; only a validated partial analysis is available.");
	}

	if (options.output) {
		await writeOutputFile(options.output, rendered);
		if (!options.quiet) io.stderr("report written to the requested output path\n");
	} else {
		io.stdout(rendered);
	}
}

async function runFast(options: CliOptions, io: AnalyzeIo): Promise<void> {
	let result: AnalysisResultV1;
	try {
		const keepDir = resolveKeepArtifactsDir(options.keepArtifacts);
		result = await runFastAnalysis({
			videoPath: options.video,
			...(options.model !== undefined ? { model: options.model } : {}),
			...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
			...(options.maxAgentTurns !== undefined ? { maxAgentTurns: options.maxAgentTurns } : {}),
			...(keepDir !== undefined ? { keepArtifactsDir: keepDir } : {}),
			...(io.signal ? { signal: io.signal } : {}),
			onProgress: (event) => {
				if (!options.quiet) io.stderr(`[${event.phase}] ${event.message}\n`);
			},
		});
	} catch (error) {
		throw toAppError(error);
	}
	await emitResult(result, options, io);
}

async function runStandard(options: CliOptions, io: AnalyzeIo): Promise<void> {
	let result: AnalysisResultV1;
	try {
		const keepDir = resolveKeepArtifactsDir(options.keepArtifacts);
		result = await runStandardAnalysis({
			videoPath: options.video,
			...(options.model !== undefined ? { model: options.model } : {}),
			...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
			...(options.reviewModel !== undefined ? { reviewModel: options.reviewModel } : {}),
			...(options.maxAgentTurns !== undefined ? { maxAgentTurns: options.maxAgentTurns } : {}),
			...(keepDir !== undefined ? { keepArtifactsDir: keepDir } : {}),
			...(io.signal ? { signal: io.signal } : {}),
			onProgress: (event) => {
				if (!options.quiet) io.stderr(`[${event.phase}] ${event.message}\n`);
			},
		});
	} catch (error) {
		throw toAppError(error);
	}
	await emitResult(result, options, io);
}

export async function analyzeVideo(options: CliOptions, io: AnalyzeIo): Promise<void> {
	if (options.dryRun) {
		await runDryRun(options, io);
		return;
	}
	if (options.mode === "fast") {
		await runFast(options, io);
		return;
	}
	await runStandard(options, io);
}
