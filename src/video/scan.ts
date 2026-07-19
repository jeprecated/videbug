/**
 * Full-recording low-resolution grayscale scan (implementation plan §6.2).
 *
 * FFmpeg decodes the source once into a downscaled gray8 `rawvideo` stream; we
 * consume that byte stream incrementally (bounded memory, with backpressure),
 * split it into fixed-size frames, and associate them one-for-one with the source
 * frame catalog. If the decoded frame count diverges from the catalog selection
 * we fail closed rather than silently misaligning timestamps. Nothing buffers the
 * whole decoded output, so multi-hour recordings do not exhaust memory.
 *
 * For ordinary recordings we scan every source frame. Above a configured safety
 * limit we scan a deterministic stride capped at a maximum scan FPS and record the
 * degraded policy so provenance is honest about reduced temporal resolution. The
 * degraded path is paired with an adaptive full-cadence rescan (see the engine)
 * so sub-stride transients cannot be silently skipped.
 */
import type { Readable } from "node:stream";
import { type FfmpegCallOptions, FfmpegError, spawnFfmpeg } from "./ffmpeg.ts";
import type { FrameCatalog } from "./probe.ts";

export class ScanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScanError";
	}
}

export interface ScanDimensions {
	width: number;
	height: number;
}

export interface ScanPolicy {
	mode: "full" | "strided";
	stride: number;
	degraded: boolean;
	scannedFrameCount: number;
}

export interface ScanFrame {
	ordinal: number;
	ptsUs: number;
	width: number;
	height: number;
	data: Uint8Array;
}

export interface ScanResult {
	width: number;
	height: number;
	policy: ScanPolicy;
	frames: ScanFrame[];
}

/** Result of a streaming scan: frame data is delivered via callback, not retained. */
export interface StreamScanResult {
	width: number;
	height: number;
	policy: ScanPolicy;
	frameCount: number;
}

export interface ScanOptions extends FfmpegCallOptions {
	/** Longest downscaled side, in pixels. Default 64. */
	maxDim?: number;
	/** Above this many source frames, degrade to a strided scan. Default 100_000. */
	frameLimit?: number;
	/** Cap the effective strided scan rate at this many FPS. Default 8. */
	maxScanFps?: number;
}

const DEFAULT_MAX_DIM = 64;
const DEFAULT_FRAME_LIMIT = 100_000;
const DEFAULT_MAX_SCAN_FPS = 8;

/** Downscaled dimensions with the longest side at `maxDim`, aspect preserved. */
export function scanDimensions(width: number, height: number, maxDim: number = DEFAULT_MAX_DIM): ScanDimensions {
	if (width <= 0 || height <= 0) throw new ScanError(`Invalid source dimensions ${width}x${height}`);
	const scale = maxDim / Math.max(width, height);
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

/** Ordinals 0, stride, 2*stride, ... below `frameCount`. */
export function selectedOrdinals(frameCount: number, stride: number): number[] {
	const ordinals: number[] = [];
	for (let n = 0; n < frameCount; n += stride) ordinals.push(n);
	return ordinals;
}

export function chooseScanPolicy(
	frameCount: number,
	sourceFps: number,
	options: { frameLimit?: number; maxScanFps?: number } = {},
): ScanPolicy {
	const frameLimit = options.frameLimit ?? DEFAULT_FRAME_LIMIT;
	const maxScanFps = options.maxScanFps ?? DEFAULT_MAX_SCAN_FPS;
	if (frameCount <= frameLimit) {
		return { mode: "full", stride: 1, degraded: false, scannedFrameCount: frameCount };
	}
	const fps = sourceFps > 0 ? sourceFps : maxScanFps;
	const stride = Math.max(1, Math.ceil(fps / maxScanFps));
	return {
		mode: "strided",
		stride,
		degraded: true,
		scannedFrameCount: selectedOrdinals(frameCount, stride).length,
	};
}

/** Split a raw gray8 buffer into `frameSize`-byte frames. Fails closed on a partial frame. */
export function splitRawFrames(buffer: Buffer | Uint8Array, frameSize: number): Uint8Array[] {
	if (frameSize <= 0) throw new ScanError(`Invalid frame size ${frameSize}`);
	if (buffer.length % frameSize !== 0) {
		throw new ScanError(`Raw scan output (${buffer.length} bytes) is not a whole number of ${frameSize}-byte frames.`);
	}
	const frames: Uint8Array[] = [];
	for (let offset = 0; offset < buffer.length; offset += frameSize) {
		frames.push(new Uint8Array(buffer.subarray(offset, offset + frameSize)));
	}
	return frames;
}

/**
 * Associate decoded scan frames one-for-one with catalog ordinals. Fails closed
 * when the counts diverge — the core trust-boundary invariant of the scan.
 */
export function associateScan(
	catalog: FrameCatalog,
	ordinals: number[],
	rawFrames: Uint8Array[],
	dims: ScanDimensions,
): ScanFrame[] {
	if (rawFrames.length !== ordinals.length) {
		throw new ScanError(
			`Scan/catalog mismatch: decoded ${rawFrames.length} frame(s) but expected ${ordinals.length}. Refusing to align timestamps to a divergent scan.`,
		);
	}
	return ordinals.map((ordinal, i) => {
		const entry = catalog.frames[ordinal];
		if (!entry) throw new ScanError(`Selected ordinal ${ordinal} is out of range for the catalog.`);
		return {
			ordinal,
			ptsUs: entry.ptsUs,
			width: dims.width,
			height: dims.height,
			data: rawFrames[i]!,
		};
	});
}

function parseRational(value: string): number | undefined {
	const match = /^(\d+)\/(\d+)$/.exec(value.trim());
	if (!match) return undefined;
	const num = Number.parseInt(match[1]!, 10);
	const den = Number.parseInt(match[2]!, 10);
	if (den === 0) return undefined;
	return num / den;
}

/** Best-effort source frame rate: prefer avg_frame_rate, else frames/duration. */
export function catalogFps(catalog: FrameCatalog): number {
	const avg = parseRational(catalog.avgFrameRate);
	if (avg && avg > 0) return avg;
	const frames = catalog.frames;
	if (frames.length >= 2) {
		const spanUs = frames[frames.length - 1]!.ptsUs - frames[0]!.ptsUs;
		if (spanUs > 0) return ((frames.length - 1) * 1_000_000) / spanUs;
	}
	return 0;
}

/**
 * Consume a raw fixed-size-frame byte stream with backpressure and fail-closed
 * framing. Peak memory is bounded to one upstream chunk plus at most one
 * incomplete frame; the whole output is never buffered. `onFrame` is awaited
 * before the next frame is emitted (serialized), so a slow consumer throttles the
 * producer. Fails closed on a partial trailing frame or an expected-count
 * mismatch. Returns early (without the partial/count checks) if the signal aborts.
 */
export interface ConsumeRawFrameStreamOptions {
	stream: Readable;
	frameSize: number;
	expectedCount?: number;
	signal?: AbortSignal;
	onFrame: (data: Uint8Array, index: number) => void | Promise<void>;
}

export async function consumeRawFrameStream(options: ConsumeRawFrameStreamOptions): Promise<number> {
	const { stream, frameSize, expectedCount, signal, onFrame } = options;
	if (frameSize <= 0) throw new ScanError(`Invalid frame size ${frameSize}`);

	let leftover: Buffer = Buffer.alloc(0);
	let count = 0;

	for await (const chunk of stream as AsyncIterable<Buffer>) {
		if (signal?.aborted) return count;
		let buf = leftover.length === 0 ? chunk : Buffer.concat([leftover, chunk]);
		let offset = 0;
		while (buf.length - offset >= frameSize) {
			if (signal?.aborted) return count;
			const frame = new Uint8Array(buf.subarray(offset, offset + frameSize));
			offset += frameSize;
			await onFrame(frame, count);
			count++;
		}
		leftover = offset === buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(offset));
		buf = leftover; // release the concatenated buffer reference
	}

	if (signal?.aborted) return count;
	if (leftover.length !== 0) {
		throw new ScanError(
			`Raw scan output ended mid-frame: ${leftover.length} trailing byte(s) < one ${frameSize}-byte frame.`,
		);
	}
	if (expectedCount !== undefined && count !== expectedCount) {
		throw new ScanError(
			`Scan/catalog mismatch: decoded ${count} frame(s) but expected ${expectedCount}. Refusing to align timestamps to a divergent scan.`,
		);
	}
	return count;
}

interface ScanPlan {
	dims: ScanDimensions;
	policy: ScanPolicy;
	ordinals: number[];
	filter: string;
}

function planScan(catalog: FrameCatalog, options: ScanOptions, forceFullCadence: boolean): ScanPlan {
	const dims = scanDimensions(catalog.width, catalog.height, options.maxDim ?? DEFAULT_MAX_DIM);
	const frameCount = catalog.frames.length;
	const policyOpts: { frameLimit?: number; maxScanFps?: number } = {};
	if (options.frameLimit !== undefined) policyOpts.frameLimit = options.frameLimit;
	if (options.maxScanFps !== undefined) policyOpts.maxScanFps = options.maxScanFps;
	const basePolicy = chooseScanPolicy(frameCount, catalogFps(catalog), policyOpts);
	const policy: ScanPolicy = forceFullCadence
		? { mode: "full", stride: 1, degraded: false, scannedFrameCount: frameCount }
		: basePolicy;

	const ordinals =
		policy.mode === "full" ? catalog.frames.map((f) => f.ordinal) : selectedOrdinals(frameCount, policy.stride);
	const scaleFilter = `scale=${dims.width}:${dims.height}:flags=area,format=gray`;
	const filter = policy.mode === "full" ? scaleFilter : `select='not(mod(n\\,${policy.stride}))',${scaleFilter}`;
	return { dims, policy, ordinals, filter };
}

export interface ScanStreamOptions extends ScanOptions {
	/** Ignore the degrade policy and scan every source frame (used by the rescan). */
	forceFullCadence?: boolean;
}

/**
 * Stream a low-resolution grayscale scan, delivering each associated `ScanFrame`
 * to `onFrame` as it is decoded. Bounded memory: no frame buffer is retained by
 * this function. Fails closed on decode error, count divergence, or partial frame.
 */
export async function scanRecordingStream(
	videoPath: string,
	catalog: FrameCatalog,
	options: ScanStreamOptions,
	onFrame: (frame: ScanFrame) => void | Promise<void>,
): Promise<StreamScanResult> {
	const { dims, policy, ordinals, filter } = planScan(catalog, options, options.forceFullCadence ?? false);

	const call: FfmpegCallOptions = {};
	if (options.signal) call.signal = options.signal;
	const child = spawnFfmpeg(
		["-v", "error", "-i", videoPath, "-an", "-vf", filter, "-fps_mode", "passthrough", "-f", "rawvideo", "-"],
		call,
	);

	let stderr = "";
	child.stderr.on("data", (d: Buffer) => {
		if (stderr.length < 8192) stderr += d.toString("utf8");
	});
	// Capture the process outcome without ever leaving an unhandled rejection.
	const exitResult: Promise<Error | null> = new Promise((resolve) => {
		child.on("error", (err) => resolve(err));
		child.on("close", (code) =>
			resolve(code === 0 ? null : new FfmpegError(`ffmpeg scan exited with code ${code}: ${stderr.trim()}`)),
		);
	});

	const consumeOpts: ConsumeRawFrameStreamOptions = {
		stream: child.stdout,
		frameSize: dims.width * dims.height,
		onFrame: async (data, index) => {
			const ordinal = ordinals[index];
			if (ordinal === undefined) {
				throw new ScanError(
					`Scan produced more frames than the ${ordinals.length}-frame catalog selection (fail closed).`,
				);
			}
			const entry = catalog.frames[ordinal]!;
			await onFrame({ ordinal, ptsUs: entry.ptsUs, width: dims.width, height: dims.height, data });
		},
	};
	if (options.signal) consumeOpts.signal = options.signal;

	let count = 0;
	try {
		count = await consumeRawFrameStream(consumeOpts);
	} catch (error) {
		child.kill("SIGKILL");
		if (!options.signal?.aborted) throw error;
	}

	const exitErr = await exitResult;
	if (options.signal?.aborted) throw new FfmpegError("ffmpeg scan cancelled");
	if (exitErr)
		throw exitErr instanceof FfmpegError ? exitErr : new FfmpegError(`ffmpeg scan failed: ${exitErr.message}`);
	if (count !== ordinals.length) {
		throw new ScanError(
			`Scan/catalog mismatch: decoded ${count} frame(s) but expected ${ordinals.length}. Refusing to align timestamps to a divergent scan.`,
		);
	}

	return { width: dims.width, height: dims.height, policy, frameCount: count };
}

/**
 * Collecting scan: gather every `ScanFrame` into an array. Convenience over
 * `scanRecordingStream` for small inputs and unit tests; large runs should prefer
 * the streaming API so frame data is not retained.
 */
export async function scanRecording(
	videoPath: string,
	catalog: FrameCatalog,
	options: ScanOptions = {},
): Promise<ScanResult> {
	const frames: ScanFrame[] = [];
	const meta = await scanRecordingStream(videoPath, catalog, options, (frame) => {
		frames.push(frame);
	});
	return { width: meta.width, height: meta.height, policy: meta.policy, frames };
}
