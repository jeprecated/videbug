/**
 * Thin, injection-safe wrappers around ffprobe/ffmpeg.
 *
 * Every invocation uses an explicit argv array via `execFile` — never a shell
 * string — so untrusted paths or values cannot be interpreted by a shell. Binary
 * names are overridable through the FFMPEG/FFPROBE environment variables so the
 * Devenv-pinned binaries are used deterministically.
 */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE ?? "ffprobe";

// Frame catalogs and showinfo logs can be large; give generous headroom.
const MAX_BUFFER = 256 * 1024 * 1024;

export class FfmpegError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "FfmpegError";
	}
}

/** Common cancellation option: an `AbortSignal` kills the spawned child process. */
export interface FfmpegCallOptions {
	signal?: AbortSignal;
}

function signalOption(options?: FfmpegCallOptions): { signal?: AbortSignal } {
	return options?.signal ? { signal: options.signal } : {};
}

export async function runFfprobeJson<T = unknown>(args: string[], options?: FfmpegCallOptions): Promise<T> {
	try {
		const { stdout } = await execFileAsync(FFPROBE, args, {
			maxBuffer: MAX_BUFFER,
			encoding: "utf8",
			...signalOption(options),
		});
		return JSON.parse(stdout) as T;
	} catch (error) {
		throw new FfmpegError(`ffprobe failed: ${(error as Error).message}`, { cause: error });
	}
}

export interface FfmpegRunResult {
	stdout: string;
	stderr: string;
}

export async function runFfmpeg(args: string[], options?: FfmpegCallOptions): Promise<FfmpegRunResult> {
	try {
		const { stdout, stderr } = await execFileAsync(FFMPEG, args, {
			maxBuffer: MAX_BUFFER,
			encoding: "utf8",
			...signalOption(options),
		});
		return { stdout, stderr };
	} catch (error) {
		throw new FfmpegError(`ffmpeg failed: ${(error as Error).message}`, { cause: error });
	}
}

/**
 * Spawn ffmpeg with piped stdio for streaming consumption of a raw output stream
 * (e.g. a `rawvideo` grayscale scan). Unlike `runFfmpeg*`, this does NOT buffer
 * stdout — the caller drains `child.stdout` incrementally, so peak memory is
 * bounded by the stream's chunk size rather than the whole decoded output. An
 * `AbortSignal` kills the child.
 */
export function spawnFfmpeg(args: string[], options?: FfmpegCallOptions): ChildProcessWithoutNullStreams {
	return spawn(FFMPEG, args, { ...signalOption(options) });
}

/** First line of `ffmpeg -version`, for provenance. */
export async function ffmpegVersion(options?: FfmpegCallOptions): Promise<string> {
	const { stdout } = await runFfmpeg(["-version"], options);
	return stdout.split("\n")[0]?.trim() ?? "unknown";
}
