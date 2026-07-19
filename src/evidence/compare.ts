/**
 * Deterministic evidence comparison (implementation plan §8.3 `compare_evidence`).
 *
 * Given two or more registered frames, this computes deterministic difference
 * metrics and an 8×8 changed-region grid for each consecutive pair. It makes no
 * semantic claim about what changed — it only reports pixel-level signals, mirror-
 * ing the change-signal metrics used by the scan so the numbers are comparable.
 *
 * Frames are decoded and downscaled to a fixed small grayscale raster before
 * comparison, so the result is independent of source resolution and cheap to
 * compute.
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { CELL_CHANGED_RATIO, PIXEL_DIFF_THRESHOLD, computeDHash, hammingDistance } from "../video/change-signals.ts";

const RASTER = 64;
const GRID = 8;

export interface ComparisonFrameInput {
	id: string;
	imagePath: string;
}

export interface PairComparison {
	fromId: string;
	toId: string;
	/** Mean absolute grayscale pixel difference (0..255). */
	absDiffMean: number;
	/** Fraction of pixels that changed beyond the threshold (0..1). */
	changedPixelRatio: number;
	/** Difference-hash Hamming distance between the two frames. */
	dHashDistance: number;
	/** Count of the 64 grid cells whose changed ratio reached the cell threshold. */
	changedCells: number;
	/** 8×8 per-cell changed-pixel ratios, row-major. */
	grid: number[];
}

export interface ComparisonResult {
	frameIds: string[];
	pairs: PairComparison[];
}

async function loadGrayRaster(path: string): Promise<Uint8Array> {
	const img = await loadImage(path);
	const canvas = createCanvas(RASTER, RASTER);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(img, 0, 0, RASTER, RASTER);
	const rgba = ctx.getImageData(0, 0, RASTER, RASTER).data;
	const gray = new Uint8Array(RASTER * RASTER);
	for (let i = 0; i < gray.length; i++) {
		const r = rgba[i * 4] ?? 0;
		const g = rgba[i * 4 + 1] ?? 0;
		const b = rgba[i * 4 + 2] ?? 0;
		// Rec. 601 luma; rounded for deterministic integer grayscale.
		gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	}
	return gray;
}

function comparePair(prev: Uint8Array, cur: Uint8Array): Omit<PairComparison, "fromId" | "toId" | "dHashDistance"> {
	const total = RASTER * RASTER;
	const cellChanged = new Array<number>(GRID * GRID).fill(0);
	const cellTotal = new Array<number>(GRID * GRID).fill(0);
	let diffSum = 0;
	let changed = 0;
	for (let y = 0; y < RASTER; y++) {
		const cellY = Math.min(GRID - 1, Math.floor((y * GRID) / RASTER));
		for (let x = 0; x < RASTER; x++) {
			const idx = y * RASTER + x;
			const d = Math.abs((cur[idx] ?? 0) - (prev[idx] ?? 0));
			diffSum += d;
			const cell = cellY * GRID + Math.min(GRID - 1, Math.floor((x * GRID) / RASTER));
			cellTotal[cell]!++;
			if (d >= PIXEL_DIFF_THRESHOLD) {
				changed++;
				cellChanged[cell]!++;
			}
		}
	}
	const grid = cellChanged.map((c, i) => {
		const t = cellTotal[i] ?? 0;
		return t === 0 ? 0 : c / t;
	});
	const changedCells = grid.reduce((acc, ratio) => acc + (ratio >= CELL_CHANGED_RATIO ? 1 : 0), 0);
	return {
		absDiffMean: diffSum / total,
		changedPixelRatio: changed / total,
		changedCells,
		grid,
	};
}

export async function compareEvidence(frames: readonly ComparisonFrameInput[]): Promise<ComparisonResult> {
	if (frames.length < 2) {
		throw new Error("compare_evidence requires at least two registered frames");
	}
	const rasters = await Promise.all(frames.map((f) => loadGrayRaster(f.imagePath)));
	const hashes = rasters.map((r) => computeDHash(r, RASTER, RASTER));
	const pairs: PairComparison[] = [];
	for (let i = 1; i < frames.length; i++) {
		const metrics = comparePair(rasters[i - 1]!, rasters[i]!);
		pairs.push({
			fromId: frames[i - 1]!.id,
			toId: frames[i]!.id,
			dHashDistance: hammingDistance(hashes[i - 1]!, hashes[i]!),
			...metrics,
		});
	}
	return { frameIds: frames.map((f) => f.id), pairs };
}
