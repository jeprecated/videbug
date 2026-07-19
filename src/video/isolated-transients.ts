/**
 * Deterministic detection of ISOLATED short transients (M7 mitigation).
 *
 * An isolated transient is a brief, LOCALISED event that flashes up on an otherwise
 * stable screen and then clears — for example a leaked debug/placeholder string that
 * renders for a fraction of a second in a corner, or a momentary error/'Waiting'/
 * 'cleared' flash. It is exactly the kind of sub-second event a sparse contact sheet
 * steps over.
 *
 * Detection is purely SOURCE-RELATIVE and carries NO content constants (no
 * darkness/text/PTS thresholds tied to any recording). It works from the existing
 * per-frame change signals only:
 *
 *   - ACTIVITY ISLAND: a short run of active frames (merging across tiny stable
 *     gaps) no longer than a small multiple of the frame interval (`maxIslandFrames`)
 *     — the "brief" criterion;
 *   - HIGH PEAK: the island's strongest changed-pixel ratio is in the recording's
 *     own high percentile (`highChangePercentile`) — "high-change relative to the
 *     recording";
 *   - LOCALISED: the peak is LOCAL motion (a partial-frame change), which is what an
 *     overlay/text/toast flash looks like, so a PERMANENT whole-frame scene cut
 *     (global motion, a durable A->B transition) is not mistaken for a transient;
 *   - ISOLATED: at least `minFlankFrames` low-change held frames on BOTH outer
 *     sides, so a BUSY cluster of rapid changes is never promoted individually;
 *   - FEATURELESS BACKGROUND: at least one flank frame is near-uniform (its 8x8
 *     difference-hash has at most `maxFlankFeatureBits` bits set), i.e. content
 *     flashed on an otherwise blank / unrendered screen. This is the general
 *     placeholder/'didn't render' signature and, crucially, keeps the detector RARE:
 *     ordinary incremental UI updates (streaming text, tag counters) happen against
 *     a busy, high-complexity background and are NOT promoted. It is a structural
 *     property of the frame, not a colour/darkness/text/PTS constant.
 *
 * GRADUAL / sustained changes are excluded because they exceed the island length.
 * The READ frame is the island's interior HELD frame (the brief static state itself
 * — e.g. the frame on which the leaked string is fully rendered and still), not the
 * change boundary, so a downstream full-resolution read lands on legible content
 * rather than the transition into the next screen. Its ordinal/PTS are PRESERVED.
 * The peak changed-pixel ratio is kept as the deterministic ranking key (desc, then
 * ordinal asc).
 */
import type { ChangeSignal } from "./change-signals.ts";

export interface IsolatedTransient {
	/** First island frame ordinal. */
	startOrdinal: number;
	/** Last island frame ordinal. */
	endOrdinal: number;
	startPtsUs: number;
	endPtsUs: number;
	/**
	 * The frame to READ at full resolution: the island's interior HELD frame showing
	 * the brief static state (the flashed content itself), or the first island frame
	 * when the island has no interior held frame. PRESERVED.
	 */
	peakOrdinal: number;
	peakPtsUs: number;
	/** The island's strongest changed-pixel ratio (deterministic ranking key). */
	peakRatio: number;
}

export interface IsolatedTransientOptions {
	/** Island at most this many scan frames (a small multiple of the frame interval). */
	maxIslandFrames?: number;
	/** Low-change held frames required on each outer side (isolation). */
	minFlankFrames?: number;
	/** Active frames separated by at most this many stable frames are one island. */
	mergeGapFrames?: number;
	/** The peak must reach this changed-pixel-ratio percentile of the recording. */
	highChangePercentile?: number;
	/**
	 * At least one flank frame's 8x8 difference-hash must have no more than this many
	 * bits set — a near-featureless (blank / unrendered) background. Keeps the detector
	 * rare: content flashed on a blank screen, not ordinary busy-background UI churn.
	 */
	maxFlankFeatureBits?: number;
}

const DEFAULTS = {
	maxIslandFrames: 8,
	minFlankFrames: 3,
	mergeGapFrames: 2,
	highChangePercentile: 0.95,
	maxFlankFeatureBits: 8,
} as const;

/** A deeply-stable frame: no motion, or an exact/near duplicate of its predecessor. */
function isLowChange(s: ChangeSignal): boolean {
	return s.motion === "none" || s.duplicate === "exact" || s.duplicate === "near";
}

/** Number of set bits in a difference-hash (its structural feature count, 0..64). */
function featureBits(dHash: bigint): number {
	let v = dHash < 0n ? -dHash : dHash;
	let count = 0;
	while (v > 0n) {
		v &= v - 1n;
		count++;
	}
	return count;
}

/** Nearest-rank percentile of a numeric series (empty -> 0). */
function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const clampedP = Math.min(1, Math.max(0, p));
	return sorted[Math.min(sorted.length - 1, Math.floor(clampedP * (sorted.length - 1)))]!;
}

export function detectIsolatedTransients(
	signals: ChangeSignal[],
	options: IsolatedTransientOptions = {},
): IsolatedTransient[] {
	const opts = { ...DEFAULTS, ...options };
	const minFlank = Math.max(1, Math.floor(opts.minFlankFrames));
	const maxIsland = Math.max(1, Math.floor(opts.maxIslandFrames));
	const mergeGap = Math.max(0, Math.floor(opts.mergeGapFrames));
	const len = signals.length;
	if (len < minFlank * 2 + 2) return [];

	const threshold = percentile(
		signals.map((s) => s.changedPixelRatio),
		opts.highChangePercentile,
	);
	const active = (i: number): boolean => !isLowChange(signals[i]!);
	const stableFlank = (from: number, to: number): boolean => {
		if (from < 0 || to >= len) return false;
		for (let i = from; i <= to; i++) if (!isLowChange(signals[i]!)) return false;
		return true;
	};

	const found: IsolatedTransient[] = [];
	let i = 0;
	while (i < len) {
		if (!active(i)) {
			i++;
			continue;
		}
		// Grow an activity island, merging stable gaps of at most `mergeGap`.
		const a = i;
		let b = i;
		let j = i + 1;
		let gap = 0;
		while (j < len) {
			if (active(j)) {
				b = j;
				gap = 0;
			} else if (++gap > mergeGap) {
				break;
			}
			j++;
		}
		const nextStart = b + 1;
		const span = b - a + 1;

		// Ranking strength: the island's strongest change.
		let peak = a;
		for (let m = a; m <= b; m++) {
			if (signals[m]!.changedPixelRatio > signals[peak]!.changedPixelRatio) peak = m;
		}
		// READ frame: the interior HELD (low-change) frame nearest the island centre —
		// the brief static state (e.g. the fully-rendered leaked string) rather than the
		// change boundary that shows the next screen. Fall back to the first island frame.
		const centre = (a + b) / 2;
		let readFrame = a;
		let bestDist = Number.POSITIVE_INFINITY;
		for (let m = a; m <= b; m++) {
			if (!isLowChange(signals[m]!)) continue;
			const dist = Math.abs(m - centre);
			if (dist < bestDist) {
				bestDist = dist;
				readFrame = m;
			}
		}

		// A near-featureless flank (blank/unrendered screen) on at least one side.
		const featurelessFlank =
			a - 1 >= 0 &&
			b + 1 < len &&
			Math.min(featureBits(signals[a - 1]!.dHash), featureBits(signals[b + 1]!.dHash)) <= opts.maxFlankFeatureBits;

		const qualifies =
			span <= maxIsland &&
			signals[peak]!.changedPixelRatio >= threshold &&
			signals[peak]!.motion === "local" &&
			featurelessFlank &&
			stableFlank(a - minFlank, a - 1) &&
			stableFlank(b + 1, b + minFlank);

		if (qualifies) {
			found.push({
				startOrdinal: signals[a]!.ordinal,
				endOrdinal: signals[b]!.ordinal,
				startPtsUs: signals[a]!.ptsUs,
				endPtsUs: signals[b]!.ptsUs,
				peakOrdinal: signals[readFrame]!.ordinal,
				peakPtsUs: signals[readFrame]!.ptsUs,
				peakRatio: signals[peak]!.changedPixelRatio,
			});
		}
		i = nextStart;
	}

	return found.sort((a, b) => b.peakRatio - a.peakRatio || a.peakOrdinal - b.peakOrdinal);
}
