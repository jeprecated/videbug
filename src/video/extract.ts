/**
 * Exact source-frame extraction with fail-closed verification.
 *
 * Requested times are resolved to explicit decode ordinals against the frame
 * catalog and selected with `select=eq(n,ordinal)` plus `-fps_mode passthrough`,
 * which preserves source PTS (never a constant-output-frame-rate pipeline). The
 * authoritative per-output PTS is read from the `showinfo` filter log, not from
 * output filenames. `verifyExtraction` then fails closed on any count mismatch,
 * duplicate, ordering regression, or ordinal->PTS drift.
 */
import { readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type FfmpegCallOptions, runFfmpeg } from "./ffmpeg.ts";
import type { FrameCatalog } from "./probe.ts";

export interface ExtractedFrame {
	requestedOrdinal: number;
	ptsUs: number;
	width: number;
	height: number;
	path: string;
}

export interface ExtractionResult {
	frames: ExtractedFrame[];
}

export interface ExtractionVerification {
	ok: boolean;
	errors: string[];
}

export class ExtractionError extends Error {
	constructor(
		message: string,
		readonly errors: string[],
	) {
		super(message);
		this.name = "ExtractionError";
	}
}

interface ShowinfoFrame {
	ptsUs: number;
	width: number;
	height: number;
}

// One showinfo line per output frame, e.g.
//   [Parsed_showinfo_1 @ 0x..] n:   0 pts:   0 pts_time:0 ... s:64x64 ...
const SHOWINFO_LINE = /pts_time:([\d.]+).*?\bs:(\d+)x(\d+)/;

function parseShowinfo(stderr: string): ShowinfoFrame[] {
	const frames: ShowinfoFrame[] = [];
	for (const line of stderr.split("\n")) {
		if (!line.includes("pts_time:")) continue;
		const match = SHOWINFO_LINE.exec(line);
		if (!match) continue;
		const seconds = Number.parseFloat(match[1]!);
		frames.push({
			ptsUs: Math.round(seconds * 1_000_000),
			width: Number.parseInt(match[2]!, 10),
			height: Number.parseInt(match[3]!, 10),
		});
	}
	return frames;
}

function uniqueSortedOrdinals(ordinals: number[]): number[] {
	return [...new Set(ordinals)].sort((a, b) => a - b);
}

/**
 * Verify an extraction against the catalog. Pure and fail-closed: returns every
 * violation it finds rather than throwing, so it is directly unit-testable.
 */
export function verifyExtraction(
	requestedOrdinals: number[],
	catalog: FrameCatalog,
	extracted: ExtractedFrame[],
): ExtractionVerification {
	const errors: string[] = [];
	const sorted = uniqueSortedOrdinals(requestedOrdinals);

	if (extracted.length !== sorted.length) {
		errors.push(`count mismatch: requested ${sorted.length} distinct frame(s) but got ${extracted.length} output(s)`);
	}

	for (let i = 0; i < extracted.length; i++) {
		const frame = extracted[i]!;
		if (i > 0) {
			const prev = extracted[i - 1]!;
			if (frame.ptsUs === prev.ptsUs) {
				errors.push(`duplicate output PTS ${frame.ptsUs}us at positions ${i - 1} and ${i}`);
			} else if (frame.ptsUs < prev.ptsUs) {
				errors.push(`out-of-order output: PTS ${frame.ptsUs}us follows ${prev.ptsUs}us`);
			}
		}
		if (frame.width <= 0 || frame.height <= 0) {
			errors.push(`invalid dimensions at position ${i}: ${frame.width}x${frame.height}`);
		}
	}

	// Ordinal -> PTS mapping: the i-th chronological output must carry the exact
	// catalog PTS of the i-th requested ordinal.
	const mapped = Math.min(extracted.length, sorted.length);
	for (let i = 0; i < mapped; i++) {
		const ordinal = sorted[i]!;
		const expected = catalog.frames[ordinal]?.ptsUs;
		const actual = extracted[i]!.ptsUs;
		if (expected === undefined) {
			errors.push(`requested ordinal ${ordinal} is out of range for the catalog`);
		} else if (expected !== actual) {
			errors.push(`ordinal->PTS drift: ordinal ${ordinal} expected ${expected}us but output carried ${actual}us`);
		}
	}

	return { ok: errors.length === 0, errors };
}

export async function extractExactFrames(
	videoPath: string,
	ordinals: number[],
	catalog: FrameCatalog,
	outDir: string,
	options: FfmpegCallOptions = {},
): Promise<ExtractionResult> {
	const sorted = uniqueSortedOrdinals(ordinals);
	if (sorted.length === 0) return { frames: [] };

	for (const ordinal of sorted) {
		if (ordinal < 0 || ordinal >= catalog.frames.length) {
			throw new ExtractionError(`Requested ordinal ${ordinal} is out of range [0, ${catalog.frames.length})`, [
				`ordinal ${ordinal} out of range`,
			]);
		}
	}

	await mkdir(outDir, { recursive: true });

	const selectExpr = sorted.map((o) => `eq(n\\,${o})`).join("+");
	const filter = `select=${selectExpr},showinfo`;
	const outputPattern = join(outDir, "frame-%06d.png");

	const { stderr } = await runFfmpeg(
		["-y", "-v", "info", "-i", videoPath, "-vf", filter, "-fps_mode", "passthrough", outputPattern],
		options,
	);

	const info = parseShowinfo(stderr);
	const files = readdirSync(outDir)
		.filter((name) => name.startsWith("frame-") && name.endsWith(".png"))
		.sort();

	const frames: ExtractedFrame[] = info.map((frame, i) => ({
		requestedOrdinal: sorted[i] ?? -1,
		ptsUs: frame.ptsUs,
		width: frame.width,
		height: frame.height,
		path: files[i] ? join(outDir, files[i]!) : "",
	}));

	const verification = verifyExtraction(sorted, catalog, frames);
	if (!verification.ok) {
		throw new ExtractionError(
			`Extraction verification failed:\n${verification.errors.join("\n")}`,
			verification.errors,
		);
	}

	return { frames };
}
