/**
 * Deterministic per-frame change signals over the low-resolution grayscale scan.
 *
 * Every signal is a pure function of the downscaled gray8 frames, so the same
 * input always yields the same output and the whole module is unit-testable
 * without ffmpeg. Signals are inexpensive and proposal-only: they inform the
 * candidate-window builder, they never assert semantic meaning.
 *
 * Per adjacent pair of frames we compute:
 *   - `absDiffMean`         mean absolute pixel difference (0..255);
 *   - `changedPixelRatio`   fraction of pixels whose diff exceeds a threshold;
 *   - `dHash` / distance    a 64-bit difference hash and its Hamming distance;
 *   - `grid`                an 8x8 per-cell changed-pixel ratio;
 *   - `motion`              none / local / global from the grid;
 *   - `duplicate`           exact / near / none.
 */

/** Absolute per-pixel difference (0..255) at or above which a pixel is "changed". */
export const PIXEL_DIFF_THRESHOLD = 16;
/** A grid cell counts as "changed" when this fraction of its pixels changed. */
export const CELL_CHANGED_RATIO = 0.1;
/** At or above this many changed cells (of 64), motion is treated as global. */
export const GLOBAL_CELL_COUNT = 32;
/** ...or when this fraction of all pixels changed, regardless of cell spread. */
export const GLOBAL_PIXEL_RATIO = 0.4;
/** Near-duplicate: dHash Hamming distance at or below this. */
export const NEAR_HASH_DISTANCE = 4;
/** ...and no more than this fraction of pixels changed. */
export const NEAR_PIXEL_RATIO = 0.02;

const GRID = 8;
const GRID_CELLS = GRID * GRID;

export interface ScanFrameInput {
	ordinal: number;
	ptsUs: number;
	width: number;
	height: number;
	data: Uint8Array;
}

export type Motion = "none" | "local" | "global";
export type Duplicate = "none" | "exact" | "near";

export interface ChangeSignal {
	ordinal: number;
	ptsUs: number;
	/** Mean absolute pixel difference vs the previous frame (0..255). */
	absDiffMean: number;
	/** Fraction of pixels that changed beyond `PIXEL_DIFF_THRESHOLD` (0..1). */
	changedPixelRatio: number;
	/** 64-bit difference hash of this frame. */
	dHash: bigint;
	/** Hamming distance of this frame's dHash vs the previous frame's. */
	dHashDistance: number;
	/** 8x8 = 64 per-cell changed-pixel ratios, row-major. */
	grid: number[];
	/** Number of grid cells whose changed ratio reached `CELL_CHANGED_RATIO`. */
	changedCells: number;
	motion: Motion;
	duplicate: Duplicate;
	/** Ordinal of the frame this one duplicates (the previous frame), when any. */
	duplicateOf?: number;
}

/** Count differing bits between two 64-bit hashes. */
export function hammingDistance(a: bigint, b: bigint): number {
	let x = a ^ b;
	let count = 0;
	while (x > 0n) {
		x &= x - 1n;
		count++;
	}
	return count;
}

/** Nearest-neighbour sample of a gray8 frame at fractional coordinates. */
function sample(data: Uint8Array, width: number, height: number, fx: number, fy: number): number {
	const x = Math.min(width - 1, Math.max(0, Math.round(fx)));
	const y = Math.min(height - 1, Math.max(0, Math.round(fy)));
	return data[y * width + x] ?? 0;
}

/**
 * Difference hash: resample to a 9x8 grid and, for each of the 8 rows, emit one
 * bit per adjacent horizontal pair (left brighter than right). 8 rows x 8 pairs
 * = 64 bits. Flat frames hash to 0 regardless of brightness; horizontal gradients
 * and structure produce distinct hashes.
 */
export function computeDHash(data: Uint8Array, width: number, height: number): bigint {
	let hash = 0n;
	let bit = 0n;
	const cols = 9;
	const rows = 8;
	for (let row = 0; row < rows; row++) {
		const fy = height <= 1 ? 0 : (row * (height - 1)) / (rows - 1);
		let prev = sample(data, width, height, 0, fy);
		for (let col = 1; col < cols; col++) {
			const fx = width <= 1 ? 0 : (col * (width - 1)) / (cols - 1);
			const cur = sample(data, width, height, fx, fy);
			if (prev > cur) hash |= 1n << bit;
			prev = cur;
			bit++;
		}
	}
	return hash;
}

/**
 * Fraction of pixels whose absolute difference reaches `PIXEL_DIFF_THRESHOLD`.
 * A cheap scalar activity metric (no grid/hash), used by the degraded-policy
 * full-cadence rescan to catch sub-stride transients without heavy per-frame work.
 */
export function changedPixelRatio(prev: Uint8Array, cur: Uint8Array): number {
	const total = cur.length;
	if (total === 0) return 0;
	let changed = 0;
	for (let i = 0; i < total; i++) {
		if (Math.abs((cur[i] ?? 0) - (prev[i] ?? 0)) >= PIXEL_DIFF_THRESHOLD) changed++;
	}
	return changed / total;
}

interface PairMetrics {
	absDiffMean: number;
	changedPixelRatio: number;
	grid: number[];
	changedCells: number;
}

function comparePair(prev: ScanFrameInput, cur: ScanFrameInput): PairMetrics {
	const { width, height } = cur;
	const total = width * height;
	const cellChangedCounts = new Array<number>(GRID_CELLS).fill(0);
	const cellTotals = new Array<number>(GRID_CELLS).fill(0);
	let diffSum = 0;
	let changed = 0;

	for (let y = 0; y < height; y++) {
		const cellY = Math.min(GRID - 1, Math.floor((y * GRID) / height));
		for (let x = 0; x < width; x++) {
			const idx = y * width + x;
			const d = Math.abs((cur.data[idx] ?? 0) - (prev.data[idx] ?? 0));
			diffSum += d;
			const cell = cellY * GRID + Math.min(GRID - 1, Math.floor((x * GRID) / width));
			cellTotals[cell]!++;
			if (d >= PIXEL_DIFF_THRESHOLD) {
				changed++;
				cellChangedCounts[cell]!++;
			}
		}
	}

	const grid = cellChangedCounts.map((c, i) => {
		const t = cellTotals[i] ?? 0;
		return t === 0 ? 0 : c / t;
	});
	const changedCells = grid.reduce((acc, ratio) => acc + (ratio >= CELL_CHANGED_RATIO ? 1 : 0), 0);

	return {
		absDiffMean: total === 0 ? 0 : diffSum / total,
		changedPixelRatio: total === 0 ? 0 : changed / total,
		grid,
		changedCells,
	};
}

function classifyMotion(metrics: PairMetrics): Motion {
	if (metrics.changedCells === 0) return "none";
	if (metrics.changedCells >= GLOBAL_CELL_COUNT || metrics.changedPixelRatio >= GLOBAL_PIXEL_RATIO) return "global";
	return "local";
}

function classifyDuplicate(metrics: PairMetrics, dHashDistance: number): Duplicate {
	if (metrics.changedPixelRatio === 0 && dHashDistance === 0) return "exact";
	if (dHashDistance <= NEAR_HASH_DISTANCE && metrics.changedPixelRatio <= NEAR_PIXEL_RATIO) return "near";
	return "none";
}

/**
 * Incremental change-signal computation. Holds only the previous frame and its
 * dHash, so a caller streaming frames one at a time (e.g. the scan) computes the
 * full signal series in bounded memory without retaining every frame's pixels.
 */
export interface SignalAccumulator {
	push(frame: ScanFrameInput): ChangeSignal;
}

export function createSignalAccumulator(): SignalAccumulator {
	let prev: ScanFrameInput | undefined;
	let prevHash: bigint | undefined;

	return {
		push(frame: ScanFrameInput): ChangeSignal {
			const dHash = computeDHash(frame.data, frame.width, frame.height);

			if (prev === undefined) {
				prev = frame;
				prevHash = dHash;
				return {
					ordinal: frame.ordinal,
					ptsUs: frame.ptsUs,
					absDiffMean: 0,
					changedPixelRatio: 0,
					dHash,
					dHashDistance: 0,
					grid: new Array<number>(GRID_CELLS).fill(0),
					changedCells: 0,
					motion: "none",
					duplicate: "none",
				};
			}

			const metrics = comparePair(prev, frame);
			const dHashDistance = prevHash === undefined ? 0 : hammingDistance(prevHash, dHash);
			const duplicate = classifyDuplicate(metrics, dHashDistance);

			const signal: ChangeSignal = {
				ordinal: frame.ordinal,
				ptsUs: frame.ptsUs,
				absDiffMean: metrics.absDiffMean,
				changedPixelRatio: metrics.changedPixelRatio,
				dHash,
				dHashDistance,
				grid: metrics.grid,
				changedCells: metrics.changedCells,
				motion: classifyMotion(metrics),
				duplicate,
			};
			if (duplicate !== "none") signal.duplicateOf = prev.ordinal;

			prev = frame;
			prevHash = dHash;
			return signal;
		},
	};
}

/**
 * Compute the ordered change-signal series for a scan. Frame 0 has no predecessor,
 * so it carries zeroed diff metrics and is never a duplicate. A thin batch wrapper
 * over `createSignalAccumulator`.
 */
export function computeChangeSignals(frames: ScanFrameInput[]): ChangeSignal[] {
	const acc = createSignalAccumulator();
	return frames.map((frame) => acc.push(frame));
}
