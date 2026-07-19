/**
 * Source-PTS frame catalog.
 *
 * This is the evidence trust boundary. Per-frame timestamps come from ffprobe's
 * `best_effort_timestamp_time`, normalized to integer microseconds, and are never
 * derived from output sequence numbers or the (on VFR input, misleading) average
 * frame rate. A non-monotonic catalog or a missing timestamp fails closed.
 */
import { runFfprobeJson } from "./ffmpeg.ts";

export interface FrameCatalogEntry {
	/** Zero-based decode ordinal of this frame within the stream. */
	ordinal: number;
	/** Source presentation timestamp in integer microseconds. */
	ptsUs: number;
	keyFrame: boolean;
	width: number;
	height: number;
}

export interface FrameCatalog {
	streamIndex: number;
	codec: string;
	width: number;
	height: number;
	timeBase: string;
	avgFrameRate: string;
	rFrameRate: string;
	durationMs?: number;
	frames: FrameCatalogEntry[];
}

export class FrameCatalogError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FrameCatalogError";
	}
}

export interface ProbeStream {
	index?: number;
	codec_name?: string;
	width?: number;
	height?: number;
	avg_frame_rate?: string;
	r_frame_rate?: string;
	time_base?: string;
}

export interface ProbeFrame {
	best_effort_timestamp_time?: string;
	key_frame?: number;
	width?: number;
	height?: number;
}

export interface ParseFrameCatalogInput {
	stream: ProbeStream;
	frames: ProbeFrame[];
	formatDuration?: string;
	/** Stream index to record when the probed stream omits its own index. */
	streamIndexFallback?: number;
}

function parsePtsUs(value: string | undefined, ordinal: number): number {
	if (value === undefined || value === "N/A") {
		throw new FrameCatalogError(
			`Frame ${ordinal} has no best_effort_timestamp_time; cannot build a trustworthy catalog.`,
		);
	}
	const seconds = Number.parseFloat(value);
	if (!Number.isFinite(seconds)) {
		throw new FrameCatalogError(`Frame ${ordinal} has a non-finite timestamp: ${value}`);
	}
	return Math.round(seconds * 1_000_000);
}

/**
 * Pure frame-catalog builder over already-probed data. Extracted from
 * `buildFrameCatalog` so the fail-closed invariants (missing/`N/A` timestamps,
 * non-monotonic PTS, empty streams) are directly unit-testable without spawning
 * ffprobe. Never derives timestamps from output order or the average frame rate.
 */
export function parseFrameCatalog(input: ParseFrameCatalogInput): FrameCatalog {
	const { stream } = input;
	const rawFrames = input.frames;
	if (rawFrames.length === 0) throw new FrameCatalogError("No decodable frames in stream");

	const streamWidth = stream.width ?? 0;
	const streamHeight = stream.height ?? 0;

	const frames: FrameCatalogEntry[] = rawFrames.map((frame, ordinal) => ({
		ordinal,
		ptsUs: parsePtsUs(frame.best_effort_timestamp_time, ordinal),
		keyFrame: frame.key_frame === 1,
		width: frame.width ?? streamWidth,
		height: frame.height ?? streamHeight,
	}));

	// Reject a non-monotonic catalog: presentation order must not regress.
	for (let i = 1; i < frames.length; i++) {
		if (frames[i]!.ptsUs < frames[i - 1]!.ptsUs) {
			throw new FrameCatalogError(
				`Non-monotonic catalog: frame ${i} PTS ${frames[i]!.ptsUs}us precedes frame ${i - 1} PTS ${frames[i - 1]!.ptsUs}us.`,
			);
		}
	}

	const durationSeconds = input.formatDuration ? Number.parseFloat(input.formatDuration) : undefined;

	const catalog: FrameCatalog = {
		streamIndex: stream.index ?? input.streamIndexFallback ?? 0,
		codec: stream.codec_name ?? "unknown",
		width: streamWidth,
		height: streamHeight,
		timeBase: stream.time_base ?? "",
		avgFrameRate: stream.avg_frame_rate ?? "",
		rFrameRate: stream.r_frame_rate ?? "",
		frames,
	};
	if (durationSeconds !== undefined && Number.isFinite(durationSeconds)) {
		catalog.durationMs = Math.round(durationSeconds * 1000);
	}
	return catalog;
}

export async function buildFrameCatalog(videoPath: string, options?: { streamIndex?: number }): Promise<FrameCatalog> {
	const streamSelector = `v:${options?.streamIndex ?? 0}`;

	const meta = await runFfprobeJson<{ streams?: ProbeStream[]; format?: { duration?: string } }>([
		"-v",
		"error",
		"-select_streams",
		streamSelector,
		"-show_entries",
		"stream=index,codec_name,width,height,avg_frame_rate,r_frame_rate,time_base",
		"-show_entries",
		"format=duration",
		"-of",
		"json",
		videoPath,
	]);

	const stream = meta.streams?.[0];
	if (!stream) throw new FrameCatalogError(`No video stream ${streamSelector} in ${videoPath}`);

	const framesJson = await runFfprobeJson<{ frames?: ProbeFrame[] }>([
		"-v",
		"error",
		"-select_streams",
		streamSelector,
		"-show_entries",
		"frame=best_effort_timestamp_time,key_frame,width,height",
		"-of",
		"json",
		videoPath,
	]);

	const parseInput: ParseFrameCatalogInput = {
		stream,
		frames: framesJson.frames ?? [],
	};
	if (meta.format?.duration !== undefined) parseInput.formatDuration = meta.format.duration;
	if (options?.streamIndex !== undefined) parseInput.streamIndexFallback = options.streamIndex;

	return parseFrameCatalog(parseInput);
}
