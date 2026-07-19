/**
 * Deterministic overview frame selection (implementation plan §8.3 `inspect_overview`).
 *
 * The overview is the analyst's first, whole-duration view of the recording. Its
 * frame set is chosen deterministically from the evidence engine's output so the
 * same recording always yields the same overview. It combines, in priority order:
 *
 *   - the first and final source frames (endpoints are always represented);
 *   - uniformly distributed temporal anchors across the whole duration;
 *   - the strongest change boundaries (hard cuts / global transitions);
 *   - the strongest short transients (brief bursts bounded by stability);
 *   - representatives of long stable spans and sustained local-animation spans.
 *
 * The result is a de-duplicated, chronologically ordered list of source frame
 * ordinals, capped at a cell budget while always preserving the endpoints.
 */
import type { CandidateWindow } from "../video/candidates.ts";

export interface OverviewInput {
	/** Total number of frames in the source catalog. */
	frameCount: number;
	/** Ranked candidate windows from the evidence engine. */
	candidates: CandidateWindow[];
	/**
	 * Ordinals that MUST be present in the overview regardless of the cell cap — used
	 * to guarantee isolated-transient peak frames get registered so `inspect_frame`
	 * can read them without spending an extra range inspection.
	 */
	protectedOrdinals?: number[];
}

export interface OverviewSelectionOptions {
	/** Uniform temporal anchors, including first and final (default 12). */
	uniformAnchors?: number;
	/** Strongest boundary windows to include (default 8). */
	maxBoundaries?: number;
	/** Strongest transient windows to include (default 6). */
	maxTransients?: number;
	/** Representative frames from the longest stable spans (default 6). */
	maxStableReps?: number;
	/** Representative frames from the longest local-animation spans (default 4). */
	maxLocalAnimationReps?: number;
	/** Hard cap on total overview cells (default 48). Endpoints are always kept. */
	maxCells?: number;
}

const DEFAULTS = {
	uniformAnchors: 12,
	maxBoundaries: 8,
	maxTransients: 6,
	maxStableReps: 6,
	maxLocalAnimationReps: 4,
	maxCells: 48,
} as const;

function clampOrdinal(value: number, frameCount: number): number {
	if (value < 0) return 0;
	if (value >= frameCount) return frameCount - 1;
	return value;
}

/** Candidates are pre-ranked (score desc); take the top `n` representatives of a kind. */
function topRepresentatives(candidates: CandidateWindow[], kind: CandidateWindow["kind"], n: number): number[] {
	const out: number[] = [];
	for (const candidate of candidates) {
		if (candidate.kind !== kind) continue;
		out.push(candidate.representativeOrdinal);
		if (out.length >= n) break;
	}
	return out;
}

/**
 * Reduce an ordered ordinal list to at most `maxCells`, always preserving the
 * first and last entries and keeping an evenly distributed subset of the middle.
 */
function capPreservingEndpoints(sorted: number[], maxCells: number): number[] {
	if (sorted.length <= maxCells) return sorted;
	if (maxCells <= 2) return maxCells === 1 ? [sorted[0]!] : [sorted[0]!, sorted[sorted.length - 1]!];
	const kept = new Set<number>();
	const last = sorted.length - 1;
	for (let i = 0; i < maxCells; i++) {
		kept.add(Math.round((i * last) / (maxCells - 1)));
	}
	kept.add(0);
	kept.add(last);
	return [...kept].sort((a, b) => a - b).map((index) => sorted[index]!);
}

export function selectOverviewOrdinals(input: OverviewInput, options: OverviewSelectionOptions = {}): number[] {
	const opts = { ...DEFAULTS, ...options };
	const { frameCount } = input;
	if (frameCount <= 0) return [];
	if (frameCount === 1) return [0];

	const selected = new Set<number>();

	// Endpoints: the first and final source frames are always represented.
	selected.add(0);
	selected.add(frameCount - 1);

	// Uniform temporal anchors across the whole duration (includes endpoints).
	const anchors = Math.max(2, opts.uniformAnchors);
	for (let i = 0; i < anchors; i++) {
		selected.add(clampOrdinal(Math.round((i * (frameCount - 1)) / (anchors - 1)), frameCount));
	}

	// Strongest structural evidence from the deterministic candidate windows.
	for (const ordinal of topRepresentatives(input.candidates, "boundary", opts.maxBoundaries)) {
		selected.add(clampOrdinal(ordinal, frameCount));
	}
	for (const ordinal of topRepresentatives(input.candidates, "transient", opts.maxTransients)) {
		selected.add(clampOrdinal(ordinal, frameCount));
	}
	for (const ordinal of topRepresentatives(input.candidates, "stable", opts.maxStableReps)) {
		selected.add(clampOrdinal(ordinal, frameCount));
	}
	for (const ordinal of topRepresentatives(input.candidates, "local-animation", opts.maxLocalAnimationReps)) {
		selected.add(clampOrdinal(ordinal, frameCount));
	}

	const sorted = [...selected].sort((a, b) => a - b);
	const capped = capPreservingEndpoints(sorted, opts.maxCells);

	// Protected ordinals (e.g. isolated-transient peaks) are always represented, even
	// past the cell cap, so their full-resolution frames are guaranteed registerable.
	const protectedOrdinals = (input.protectedOrdinals ?? []).map((o) => clampOrdinal(o, frameCount));
	if (protectedOrdinals.length === 0) return capped;
	const union = new Set<number>([...capped, ...protectedOrdinals]);
	return [...union].sort((a, b) => a - b);
}
