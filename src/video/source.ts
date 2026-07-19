/**
 * Deterministic source fingerprint (implementation plan §5, §12).
 *
 * Produces the `AnalysisSource` block the schema requires: basename, a streamed
 * sha256 of the file (never a copy), and the stream metadata the frame catalog
 * already established. The model never supplies any of these values.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import type { AnalysisSource } from "../contracts/analysis-v1.ts";
import type { FrameCatalog } from "./probe.ts";
import { catalogFps } from "./scan.ts";

/** Stream a file through sha256 without loading it entirely into memory. */
export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve());
	});
	return hash.digest("hex");
}

function durationMsFromCatalog(catalog: FrameCatalog): number {
	if (catalog.durationMs !== undefined && catalog.durationMs > 0) return catalog.durationMs;
	const frames = catalog.frames;
	if (frames.length >= 2) {
		const spanUs = frames[frames.length - 1]!.ptsUs - frames[0]!.ptsUs;
		return Math.round(spanUs / 1000);
	}
	return 0;
}

/** Pure assembly of the source fingerprint from a known hash and catalog. */
export function sourceFromCatalog(videoPath: string, sha256: string, catalog: FrameCatalog): AnalysisSource {
	return {
		basename: basename(videoPath),
		sha256,
		durationMs: durationMsFromCatalog(catalog),
		width: catalog.width,
		height: catalog.height,
		streamIndex: catalog.streamIndex,
		averageFps: catalogFps(catalog),
	};
}

/** Fingerprint a real source file by streaming its sha256 and reading the catalog. */
export async function fingerprintSource(videoPath: string, catalog: FrameCatalog): Promise<AnalysisSource> {
	const sha256 = await sha256File(videoPath);
	return sourceFromCatalog(videoPath, sha256, catalog);
}
