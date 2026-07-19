/**
 * Exact evidence extraction: bind extracted source frames to stable evidence IDs.
 *
 * This is the registry-ready bridge between the fail-closed exact extractor
 * (`extractExactFrames`, which verifies count/PTS/ordering and rejects duplicates)
 * and the evidence identity scheme. Each returned record carries a content digest
 * derived from the actual PNG bytes, so a duplicated or swapped frame yields a
 * different ID rather than being silently presented as new evidence.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extractExactFrames } from "../video/extract.ts";
import type { FfmpegCallOptions } from "../video/ffmpeg.ts";
import type { FrameCatalog } from "../video/probe.ts";
import { formatEvidenceId } from "./evidence-id.ts";

export interface EvidenceRecord {
	/** Stable provenance ID, e.g. `v0_f000842_p057500_2c91a7`. */
	id: string;
	streamIndex: number;
	ordinal: number;
	ptsUs: number;
	ptsMs: number;
	/** First 6 hex chars of the sha256 of the extracted frame bytes. */
	contentDigest: string;
	width: number;
	height: number;
	path: string;
}

async function digestFile(path: string): Promise<string> {
	const bytes = await readFile(path);
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Extract the requested source frame ordinals and return registry-ready evidence
 * records. Throws (via `extractExactFrames`) on any count/PTS/ordering/duplicate
 * violation before any record is produced.
 */
export async function extractEvidenceFrames(
	videoPath: string,
	ordinals: number[],
	catalog: FrameCatalog,
	outDir: string,
	options: FfmpegCallOptions = {},
): Promise<EvidenceRecord[]> {
	const { frames } = await extractExactFrames(videoPath, ordinals, catalog, outDir, options);

	const records: EvidenceRecord[] = [];
	for (const frame of frames) {
		const fullDigest = await digestFile(frame.path);
		const contentDigest = fullDigest.slice(0, 6);
		records.push({
			id: formatEvidenceId({
				streamIndex: catalog.streamIndex,
				ordinal: frame.requestedOrdinal,
				ptsUs: frame.ptsUs,
				contentDigest,
			}),
			streamIndex: catalog.streamIndex,
			ordinal: frame.requestedOrdinal,
			ptsUs: frame.ptsUs,
			ptsMs: Math.round(frame.ptsUs / 1000),
			contentDigest,
			width: frame.width,
			height: frame.height,
			path: frame.path,
		});
	}
	return records;
}
