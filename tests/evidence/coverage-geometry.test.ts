import { describe, expect, it } from "vitest";
import {
	isFrameSpanCovered,
	isSpanCovered,
	mergeRangesWithTolerance,
	uncoveredFrameSubsegments,
	uncoveredSubsegments,
} from "../../src/evidence/coverage-geometry.ts";

const r = (startMs: number, endMs: number) => ({ startMs, endMs });

describe("mergeRangesWithTolerance", () => {
	it("merges overlapping ranges", () => {
		expect(mergeRangesWithTolerance([r(0, 100), r(50, 200)], 0)).toEqual([r(0, 200)]);
	});

	it("merges ranges separated only by a sub-frame gap (tail tolerance)", () => {
		// Two targeted ranges left a 40ms (one-frame @25fps) gap between them because
		// the last sampled PTS of the first is one frame before the next range's first.
		expect(mergeRangesWithTolerance([r(0, 5000), r(5040, 10000)], 40)).toEqual([r(0, 10000)]);
	});

	it("keeps ranges separated by more than the tolerance apart", () => {
		expect(mergeRangesWithTolerance([r(0, 5000), r(6000, 10000)], 40)).toEqual([r(0, 5000), r(6000, 10000)]);
	});

	it("is input-order independent and deterministic", () => {
		const a = mergeRangesWithTolerance([r(6000, 10000), r(0, 5000), r(5040, 5100)], 40);
		const b = mergeRangesWithTolerance([r(5040, 5100), r(0, 5000), r(6000, 10000)], 40);
		expect(a).toEqual(b);
	});
});

describe("uncoveredSubsegments", () => {
	it("returns the whole span when nothing is covered", () => {
		expect(uncoveredSubsegments(1000, 4000, [], 40)).toEqual([r(1000, 4000)]);
	});

	it("returns nothing when a single range contains the span within tolerance", () => {
		expect(uncoveredSubsegments(1000, 4000, [r(980, 4020)], 40)).toEqual([]);
	});

	it("treats a span reachable by a union of adjacent sub-frame-gapped ranges as covered", () => {
		// Adjacent targeted ranges with a one-frame gap must count as covering the
		// window, not leaving a sub-frame sliver flagged uninspected.
		const merged = mergeRangesWithTolerance([r(1000, 2500), r(2540, 4000)], 40);
		expect(uncoveredSubsegments(1000, 4000, merged, 40)).toEqual([]);
	});

	it("reports only genuine interior gaps wider than one frame, not sub-frame slivers", () => {
		// A real 1500ms interior gap is reported; the 30ms edge slivers are not.
		const merged = mergeRangesWithTolerance([r(970, 2000), r(3500, 4030)], 40);
		expect(uncoveredSubsegments(1000, 4000, merged, 40)).toEqual([r(2000, 3500)]);
	});

	it("reports leading and trailing uncovered slices beyond tolerance", () => {
		const merged = mergeRangesWithTolerance([r(2000, 3000)], 40);
		expect(uncoveredSubsegments(0, 5000, merged, 40)).toEqual([r(0, 2000), r(3000, 5000)]);
	});

	it("never emits a sliver at or below the tolerance", () => {
		// Coverage leaves a 40ms (== tolerance) gap at the head; it must be dropped.
		const merged = mergeRangesWithTolerance([r(40, 5000)], 40);
		expect(uncoveredSubsegments(0, 5000, merged, 40)).toEqual([]);
	});
});

describe("isSpanCovered", () => {
	it("is true iff there are no uncovered subsegments", () => {
		const merged = mergeRangesWithTolerance([r(1000, 2500), r(2540, 4000)], 40);
		expect(isSpanCovered(1000, 4000, merged, 40)).toBe(true);
		expect(isSpanCovered(1000, 6000, merged, 40)).toBe(false);
	});
});

describe("uncoveredFrameSubsegments (frame-aware, VFR-safe)", () => {
	// A static VFR gap: frames at 97533 and 100991 are CONSECUTIVE (nothing between).
	const frames = [97466, 97500, 97533, 100991, 101036, 101070];

	it("treats a multi-second VFR gap between consecutive frames as covered", () => {
		const covered = [r(77192, 97533), r(100991, 101473)];
		expect(uncoveredFrameSubsegments(77192, 100991, frames, covered)).toEqual([]);
		expect(isFrameSpanCovered(77192, 100991, frames, covered)).toBe(true);
	});

	it("reports genuinely unseen frames as an uncovered span", () => {
		const covered = [r(77192, 97533)];
		expect(uncoveredFrameSubsegments(77192, 100991, frames, covered)).toEqual([r(100991, 100991)]);
		expect(isFrameSpanCovered(77192, 100991, frames, covered)).toBe(false);
	});

	it("is covered when a range spans all the window frames despite sparse sampling", () => {
		expect(isFrameSpanCovered(97466, 101070, frames, [r(97466, 101070)])).toBe(true);
	});

	it("tolerates a one-frame boundary sample landing just inside a window edge", () => {
		// The window's extreme frames (9696, 12966) sit ~33ms outside the sampled range
		// [9729, 12933]; a one-frame tolerance credits them as covered.
		const wframes = [9696, 9729, 12933, 12966];
		expect(isFrameSpanCovered(9696, 12966, wframes, [r(9729, 12933)], 68)).toBe(true);
		// Without tolerance the extreme frames are flagged.
		expect(uncoveredFrameSubsegments(9696, 12966, wframes, [r(9729, 12933)], 0)).toEqual([
			r(9696, 9696),
			r(12966, 12966),
		]);
	});
});
