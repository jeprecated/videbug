/**
 * Exact range sampling resolved to source frame ordinals (implementation plan §8.3
 * `inspect_range`).
 *
 * A requested `[startMs, endMs]` window and a bounded `samples` count are resolved
 * to explicit source frame ordinals against the catalog PTS — never derived from
 * output sequence numbers. Frames whose source PTS falls inside the window are the
 * candidate set; up to `samples` of them are chosen evenly, always including the
 * first and last in-window frame. If the window contains no frame at all, the
 * single frame nearest the window is returned so the caller still gets evidence.
 */
import type { FrameCatalog } from "../video/probe.ts";

export interface RangeResolution {
	ordinals: number[];
	/** PTS (ms) of the first and last resolved frame; the effective inspected span. */
	resolvedStartMs: number;
	resolvedEndMs: number;
}

/** Evenly select `count` indices across `[0, length)`, including first and last. */
function evenIndices(length: number, count: number): number[] {
	if (count >= length) return Array.from({ length }, (_, i) => i);
	if (count <= 1) return [0];
	const out = new Set<number>();
	for (let i = 0; i < count; i++) {
		out.add(Math.round((i * (length - 1)) / (count - 1)));
	}
	return [...out].sort((a, b) => a - b);
}

export function resolveRangeOrdinals(
	catalog: Pick<FrameCatalog, "frames">,
	startMs: number,
	endMs: number,
	samples: number,
): RangeResolution {
	const frames = catalog.frames;
	if (frames.length === 0) return { ordinals: [], resolvedStartMs: 0, resolvedEndMs: 0 };

	const lowMs = Math.min(startMs, endMs);
	const highMs = Math.max(startMs, endMs);
	const lowUs = lowMs * 1000;
	const highUs = highMs * 1000;

	const inWindow = frames.filter((f) => f.ptsUs >= lowUs && f.ptsUs <= highUs);

	if (inWindow.length === 0) {
		// Collapsed/empty window: return the single frame nearest the window centre.
		const centerUs = (lowUs + highUs) / 2;
		let nearest = frames[0]!;
		let best = Math.abs(nearest.ptsUs - centerUs);
		for (const frame of frames) {
			const distance = Math.abs(frame.ptsUs - centerUs);
			if (distance < best) {
				best = distance;
				nearest = frame;
			}
		}
		const ms = Math.round(nearest.ptsUs / 1000);
		return { ordinals: [nearest.ordinal], resolvedStartMs: ms, resolvedEndMs: ms };
	}

	const wanted = Math.max(1, Math.floor(samples));
	const picked = evenIndices(inWindow.length, wanted).map((i) => inWindow[i]!);
	const ordinals = picked.map((f) => f.ordinal);
	return {
		ordinals,
		resolvedStartMs: Math.round(picked[0]!.ptsUs / 1000),
		resolvedEndMs: Math.round(picked[picked.length - 1]!.ptsUs / 1000),
	};
}
