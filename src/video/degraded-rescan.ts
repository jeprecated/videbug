/**
 * Degraded-policy adaptive rescan (implementation plan §6.2).
 *
 * When a very long recording forces a strided scan, a transient shorter than the
 * stride can fall entirely between sampled frames and be invisible to the strided
 * pass. To guarantee such sub-stride transients are not silently missed, the
 * engine performs a second, full-source-cadence activity pass (a cheap scalar
 * changed-pixel ratio per frame, computed in bounded memory) and feeds it here.
 *
 * `detectHiddenTransients` is a pure function over that activity plus the strided
 * pass's stable samples: it flags high-change frames that (a) were never sampled
 * and (b) sit between two samples the strided pass considered stable — i.e. a real
 * change the first pass would otherwise have reported as uninterrupted stability.
 * Each flag becomes a transient candidate window bracketed by the stable samples.
 */
import type { CandidateWindow } from "./candidates.ts";
import type { FrameCatalog } from "./probe.ts";

export interface FrameActivity {
	ordinal: number;
	/** Changed-pixel ratio vs the previous full-cadence frame (0..1). */
	ratio: number;
}

export interface DetectHiddenTransientsInput {
	/** Full-source-cadence activity, one entry per source frame, in order. */
	activity: FrameActivity[];
	/** Ordinals the strided detail pass actually scanned. */
	sampledOrdinals: number[];
	/** Sampled ordinals whose strided signal was low-change (stable). */
	stableSampledOrdinals: Set<number>;
	catalog: FrameCatalog;
	/** Changed-pixel ratio at/above which a frame counts as a transient spike. */
	transientRatio?: number;
}

const DEFAULT_TRANSIENT_RATIO = 0.4;

function bracket(sortedSampled: number[], ordinal: number): { prev?: number; next?: number } {
	let prev: number | undefined;
	let next: number | undefined;
	for (const s of sortedSampled) {
		if (s <= ordinal) prev = s;
		if (s >= ordinal) {
			next = s;
			break;
		}
	}
	const result: { prev?: number; next?: number } = {};
	if (prev !== undefined) result.prev = prev;
	if (next !== undefined) result.next = next;
	return result;
}

export function detectHiddenTransients(input: DetectHiddenTransientsInput): CandidateWindow[] {
	const transientRatio = input.transientRatio ?? DEFAULT_TRANSIENT_RATIO;
	const sampledSet = new Set(input.sampledOrdinals);
	const sortedSampled = [...input.sampledOrdinals].sort((a, b) => a - b);

	interface Hit {
		ordinal: number;
		ratio: number;
		prevSample: number;
		nextSample: number;
	}
	const hits: Hit[] = [];

	for (const entry of input.activity) {
		if (entry.ratio < transientRatio) continue;
		if (sampledSet.has(entry.ordinal)) continue; // strided pass already saw it
		const { prev, next } = bracket(sortedSampled, entry.ordinal);
		if (prev === undefined || next === undefined) continue;
		// Only "hidden" if the strided pass believed both brackets were stable.
		if (!input.stableSampledOrdinals.has(prev) || !input.stableSampledOrdinals.has(next)) continue;
		hits.push({ ordinal: entry.ordinal, ratio: entry.ratio, prevSample: prev, nextSample: next });
	}

	if (hits.length === 0) return [];

	// Group adjacent hidden ordinals that share the same bracketing samples.
	const windows: CandidateWindow[] = [];
	let group: Hit[] = [];

	const flush = () => {
		if (group.length === 0) return;
		let peak = group[0]!;
		for (const hit of group) if (hit.ratio > peak.ratio) peak = hit;
		const startOrdinal = group[0]!.prevSample;
		const endOrdinal = group[group.length - 1]!.nextSample;
		windows.push({
			kind: "transient",
			startOrdinal,
			endOrdinal,
			startPtsUs: input.catalog.frames[startOrdinal]?.ptsUs ?? 0,
			endPtsUs: input.catalog.frames[endOrdinal]?.ptsUs ?? 0,
			// Just below a directly-observed transient so it ranks prominently but
			// is distinguishable as a rescan-recovered window.
			score: 850 + peak.ratio * 100,
			representativeOrdinal: peak.ordinal,
		});
		group = [];
	};

	for (const hit of hits) {
		const last = group[group.length - 1];
		if (last && hit.ordinal - last.ordinal <= 1 && hit.prevSample === last.prevSample) {
			group.push(hit);
		} else {
			flush();
			group.push(hit);
		}
	}
	flush();

	return windows;
}
