import { describe, expect, it } from "vitest";
import {
	type ScanFrameInput,
	changedPixelRatio,
	computeChangeSignals,
	computeDHash,
	createSignalAccumulator,
	hammingDistance,
} from "../../src/video/change-signals.ts";

const W = 8;
const H = 8;

function solid(value: number): Uint8Array {
	return new Uint8Array(W * H).fill(value);
}

/** A frame that is `base` everywhere except one 2x2 block set to `blockValue`. */
function withBlock(base: number, blockValue: number, bx: number, by: number): Uint8Array {
	const data = solid(base);
	for (let y = by; y < by + 2; y++) {
		for (let x = bx; x < bx + 2; x++) {
			data[y * W + x] = blockValue;
		}
	}
	return data;
}

function frame(data: Uint8Array, ordinal: number): ScanFrameInput {
	return { ordinal, ptsUs: ordinal * 100_000, width: W, height: H, data };
}

describe("hammingDistance", () => {
	it("counts differing bits", () => {
		expect(hammingDistance(0b1011n, 0b1011n)).toBe(0);
		expect(hammingDistance(0b1011n, 0b1000n)).toBe(2);
		expect(hammingDistance(0n, 0xffffffffffffffffn)).toBe(64);
	});
});

describe("computeDHash", () => {
	it("is stable for identical frames and differs for a strong gradient change", () => {
		const flat = computeDHash(solid(128), W, H);
		const flat2 = computeDHash(solid(200), W, H);
		// A flat frame has no horizontal gradient, so its dHash is identical
		// regardless of the (uniform) brightness.
		expect(flat).toBe(flat2);

		// A left-to-right *decreasing* gradient makes each left pixel brighter than
		// its right neighbour, so dHash bits are set and it differs from a flat frame.
		const gradient = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gradient[y * W + x] = (W - 1 - x) * 30;
		expect(hammingDistance(flat, computeDHash(gradient, W, H))).toBeGreaterThan(0);
	});
});

describe("changedPixelRatio", () => {
	it("is 0 for identical frames and ~1 for a full-frame change", () => {
		expect(changedPixelRatio(solid(10), solid(10))).toBe(0);
		expect(changedPixelRatio(solid(10), solid(240))).toBeCloseTo(1, 5);
	});

	it("measures a localized change fraction", () => {
		const ratio = changedPixelRatio(solid(10), withBlock(10, 240, 0, 0));
		// 2x2 changed block over 64 pixels = 0.0625.
		expect(ratio).toBeCloseTo(4 / 64, 5);
	});
});

describe("createSignalAccumulator", () => {
	it("produces the same series as computeChangeSignals, frame by frame", () => {
		const frames = [
			frame(solid(10), 0),
			frame(withBlock(10, 220, 0, 0), 1),
			frame(solid(240), 2),
			frame(solid(240), 3),
		];
		const batch = computeChangeSignals(frames);
		const acc = createSignalAccumulator();
		const streamed = frames.map((f) => acc.push(f));
		expect(streamed).toEqual(batch);
	});
});

describe("computeChangeSignals", () => {
	it("returns a zeroed, non-duplicate first frame", () => {
		const signals = computeChangeSignals([frame(solid(50), 0)]);
		expect(signals).toHaveLength(1);
		expect(signals[0]!.changedPixelRatio).toBe(0);
		expect(signals[0]!.duplicate).toBe("none");
		expect(signals[0]!.motion).toBe("none");
		expect(signals[0]!.ordinal).toBe(0);
	});

	it("detects an exact duplicate of the previous frame", () => {
		const signals = computeChangeSignals([frame(solid(50), 0), frame(solid(50), 1)]);
		expect(signals[1]!.duplicate).toBe("exact");
		expect(signals[1]!.changedPixelRatio).toBe(0);
		expect(signals[1]!.dHashDistance).toBe(0);
		expect(signals[1]!.motion).toBe("none");
		expect(signals[1]!.duplicateOf).toBe(0);
	});

	it("classifies a small localized change as local motion", () => {
		const signals = computeChangeSignals([frame(solid(20), 0), frame(withBlock(20, 220, 0, 0), 1)]);
		const s = signals[1]!;
		expect(s.changedPixelRatio).toBeGreaterThan(0);
		expect(s.changedPixelRatio).toBeLessThan(0.2);
		expect(s.motion).toBe("local");
		expect(s.changedCells).toBeGreaterThanOrEqual(1);
		expect(s.duplicate).toBe("none");
	});

	it("classifies a full-frame change as global motion", () => {
		const signals = computeChangeSignals([frame(solid(10), 0), frame(solid(240), 1)]);
		const s = signals[1]!;
		expect(s.changedPixelRatio).toBeCloseTo(1, 5);
		expect(s.motion).toBe("global");
		expect(s.changedCells).toBe(64);
	});

	it("produces an 8x8 (64-cell) change grid", () => {
		const signals = computeChangeSignals([frame(solid(10), 0), frame(withBlock(10, 250, 0, 0), 1)]);
		expect(signals[1]!.grid).toHaveLength(64);
		// The changed 2x2 block sits in the top-left cell; that cell's ratio is > 0.
		expect(signals[1]!.grid[0]).toBeGreaterThan(0);
	});
});
