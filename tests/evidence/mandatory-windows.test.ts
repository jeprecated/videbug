import { describe, expect, it } from "vitest";
import {
	clusterIsolatedFocusWindows,
	clusterTransientWindows,
	groupMandatoryWindows,
} from "../../src/evidence/mandatory-windows.ts";

interface C {
	startMs: number;
	endMs: number;
	kind: string;
}

function c(startMs: number, endMs: number, kind = "boundary"): C {
	return { startMs, endMs, kind };
}

describe("groupMandatoryWindows", () => {
	it("returns nothing for no candidates", () => {
		expect(groupMandatoryWindows([], { maxGroups: 12, mergeGapMs: 500 })).toEqual([]);
	});

	it("merges candidates within the gap threshold into one window", () => {
		const groups = groupMandatoryWindows([c(1000, 1100), c(1300, 1400)], { maxGroups: 12, mergeGapMs: 500 });
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ startMs: 1000, endMs: 1400, candidateCount: 2 });
	});

	it("keeps candidates farther apart than the gap as separate windows", () => {
		const groups = groupMandatoryWindows([c(0, 100), c(5000, 5100)], { maxGroups: 12, mergeGapMs: 500 });
		expect(groups).toHaveLength(2);
	});

	it("never exceeds maxGroups, merging the nearest neighbours deterministically", () => {
		const candidates: C[] = [];
		for (let i = 0; i < 51; i++) candidates.push(c(i * 1000, i * 1000 + 100));
		const groups = groupMandatoryWindows(candidates, { maxGroups: 12, mergeGapMs: 200 });
		expect(groups.length).toBeLessThanOrEqual(12);
		// Every candidate is covered by exactly one window and windows are ordered/non-overlapping.
		let covered = 0;
		let prevEnd = -1;
		for (const g of groups) {
			expect(g.startMs).toBeGreaterThan(prevEnd);
			prevEnd = g.endMs;
			covered += g.candidateCount;
		}
		expect(covered).toBe(51);
	});

	it("is deterministic for the same input", () => {
		const candidates = [c(0, 100), c(400, 500), c(3000, 3100), c(3200, 3300), c(9000, 9100)];
		const a = groupMandatoryWindows(candidates, { maxGroups: 3, mergeGapMs: 300 });
		const b = groupMandatoryWindows(candidates, { maxGroups: 3, mergeGapMs: 300 });
		expect(a).toEqual(b);
		expect(a.length).toBeLessThanOrEqual(3);
	});

	it("orders windows by start time regardless of input order", () => {
		const groups = groupMandatoryWindows([c(9000, 9100), c(0, 100), c(4000, 4100)], {
			maxGroups: 12,
			mergeGapMs: 200,
		});
		expect(groups.map((g) => g.startMs)).toEqual([0, 4000, 9000]);
	});

	it("does not collapse a busy recording into one whole-video window (maxWindowMs)", () => {
		// A busy recording: 60 candidates every 2s across ~120s, all within the merge
		// gap of the previous one. Without maxWindowMs this chains into ONE window
		// spanning the whole recording, which is not targetable.
		const candidates: C[] = [];
		for (let i = 0; i < 60; i++) candidates.push(c(i * 2000, i * 2000 + 200));

		const collapsed = groupMandatoryWindows(candidates, { maxGroups: 12, mergeGapMs: 3000 });
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]!.endMs - collapsed[0]!.startMs).toBeGreaterThan(100000);

		// With maxWindowMs the same busy recording splits into <=12 balanced,
		// targetable windows, each far narrower than the whole recording, covering
		// every candidate without dropping activity.
		const balanced = groupMandatoryWindows(candidates, { maxGroups: 12, mergeGapMs: 3000, maxWindowMs: 12000 });
		expect(balanced.length).toBeGreaterThan(1);
		expect(balanced.length).toBeLessThanOrEqual(12);
		let covered = 0;
		let prevEnd = -1;
		for (const g of balanced) {
			expect(g.startMs).toBeGreaterThan(prevEnd);
			prevEnd = g.endMs;
			covered += g.candidateCount;
			expect(g.endMs - g.startMs).toBeLessThan(118000);
		}
		expect(covered).toBe(60);
	});

	it("leaves a compact quiet cluster unsplit even under maxWindowMs", () => {
		// Two nearby candidates: one narrow window is targetable, so no split.
		const groups = groupMandatoryWindows([c(1000, 1100), c(1300, 1400)], {
			maxGroups: 12,
			mergeGapMs: 500,
			maxWindowMs: 12000,
		});
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ startMs: 1000, endMs: 1400 });
	});

	it("splits at the largest internal gap first (compact, balanced windows)", () => {
		// Members at 0, 1000, 2000 then a big jump to 20000, 21000. maxWindowMs forces
		// a split; the largest internal gap (2000->20000) must be the cut point.
		const candidates = [c(0, 100), c(1000, 1100), c(2000, 2100), c(20000, 20100), c(21000, 21100)];
		const groups = groupMandatoryWindows(candidates, { maxGroups: 12, mergeGapMs: 5000, maxWindowMs: 10000 });
		expect(groups).toHaveLength(2);
		expect(groups[0]).toMatchObject({ startMs: 0, endMs: 2100 });
		expect(groups[1]).toMatchObject({ startMs: 20000, endMs: 21100 });
	});

	/** Assert windows are ascending, strictly non-overlapping, and cover every candidate. */
	function assertOrderedNonOverlappingCovering(
		groups: ReturnType<typeof groupMandatoryWindows>,
		candidates: C[],
	): void {
		let prevEnd = Number.NEGATIVE_INFINITY;
		let totalCount = 0;
		for (const g of groups) {
			expect(g.startMs).toBeGreaterThanOrEqual(prevEnd);
			expect(g.endMs).toBeGreaterThanOrEqual(g.startMs);
			prevEnd = g.endMs;
			totalCount += g.candidateCount;
		}
		// Every candidate is fully contained in the union of the (non-overlapping) windows.
		for (const cand of candidates) {
			const lo = Math.min(cand.startMs, cand.endMs);
			const hi = Math.max(cand.startMs, cand.endMs);
			const covered = groups.some((g) => g.startMs <= lo && g.endMs >= hi);
			expect(covered).toBe(true);
		}
		// Each candidate is counted in exactly one window (no double counting).
		expect(totalCount).toBe(candidates.length);
	}

	it("produces non-overlapping windows when candidates overlap each other", () => {
		// Overlapping candidates must be folded into one window, never split into
		// windows that overlap.
		const candidates = [c(1000, 5000), c(2000, 6000), c(4000, 9000), c(20000, 21000)];
		const groups = groupMandatoryWindows(candidates, { maxGroups: 12, mergeGapMs: 500, maxWindowMs: 3000 });
		assertOrderedNonOverlappingCovering(groups, candidates);
		// The overlapping cluster cannot be split without overlap, so it stays one window.
		expect(groups[0]).toMatchObject({ startMs: 1000, endMs: 9000 });
	});

	it("keeps a giant candidate spanning most of a busy video as one non-overlapping window", () => {
		// A single 'stable' candidate spans nearly the whole recording, with several
		// smaller candidates nested inside it. Splitting the giant would overlap the
		// nested windows, so it must stay one window that covers them all.
		const candidates: C[] = [c(0, 110000, "stable")];
		for (let i = 1; i <= 10; i++) candidates.push(c(i * 10000, i * 10000 + 200, "boundary"));
		const groups = groupMandatoryWindows(candidates, { maxGroups: 12, mergeGapMs: 1000, maxWindowMs: 12000 });
		assertOrderedNonOverlappingCovering(groups, candidates);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ startMs: 0, endMs: 110000, candidateCount: 11 });
	});

	it("clusters adjacent transients into TIGHT narrow windows without merging distant ones", () => {
		// Three near-adjacent transients around 57s plus distant ones. The 57s cluster
		// must stay a single narrow window (<3s), never merged with the far ones.
		const transients: C[] = [
			c(1862, 1946, "transient"),
			c(57097, 57164, "transient"),
			c(57531, 57667, "transient"),
			c(57818, 57935, "transient"),
			c(118721, 123529, "transient"),
		];
		const windows = clusterTransientWindows(transients, { mergeGapMs: 1000, maxWidthMs: 3000, maxCount: 12 });
		const around57 = windows.find((w) => w.startMs <= 57250 && w.endMs >= 57500);
		expect(around57).toBeDefined();
		expect(around57!.endMs - around57!.startMs).toBeLessThan(3000);
		expect(around57).toMatchObject({ startMs: 57097, endMs: 57935, candidateCount: 3 });
		// Windows are ordered and non-overlapping.
		let prevEnd = -1;
		for (const w of windows) {
			expect(w.startMs).toBeGreaterThanOrEqual(prevEnd);
			prevEnd = w.endMs;
		}
	});

	it("caps the number of transient clusters, keeping the busiest", () => {
		const transients: C[] = [];
		for (let i = 0; i < 30; i++) transients.push(c(i * 4000, i * 4000 + 100, "transient"));
		const windows = clusterTransientWindows(transients, { mergeGapMs: 500, maxWidthMs: 3000, maxCount: 12 });
		expect(windows.length).toBeLessThanOrEqual(12);
	});

	it("handles the real 33s stable candidate shape without overlapping windows", () => {
		// Shape observed on the reference recording: a long ~33s stable span plus a
		// cluster of boundary/transient candidates before and after it, against the
		// standard 12-range budget and ~128s duration.
		const candidates: C[] = [
			c(0, 1200, "boundary"),
			c(1200, 4800, "transition"),
			c(5000, 38000, "stable"),
			c(38000, 39500, "boundary"),
			c(40000, 42000, "local-animation"),
			c(57250, 57750, "transient"),
			c(90000, 123000, "stable"),
			c(123000, 128640, "boundary"),
		];
		const groups = groupMandatoryWindows(candidates, { maxGroups: 12, mergeGapMs: 1000, maxWindowMs: 10720 });
		assertOrderedNonOverlappingCovering(groups, candidates);
		expect(groups.length).toBeLessThanOrEqual(12);
	});
});

describe("clusterIsolatedFocusWindows", () => {
	const iso = (startMs: number, endMs: number, peakOrdinal: number, peakRatio: number) => ({
		startMs,
		endMs,
		peakOrdinal,
		peakRatio,
	});

	it("returns nothing for no isolated transients", () => {
		expect(clusterIsolatedFocusWindows([], { mergeGapMs: 1000, minDensity: 6, maxWindows: 4, maxPeaks: 8 })).toEqual({
			windows: [],
			overflow: [],
		});
	});

	it("clusters adjacent isolated transients into one density-gated window carrying every peak", () => {
		const { windows, overflow } = clusterIsolatedFocusWindows(
			[iso(43867, 44000, 660, 0.202), iso(42467, 42467, 637, 0.204)],
			{ mergeGapMs: 2000, minDensity: 6, maxWindows: 4, maxPeaks: 8 },
		);
		expect(overflow).toHaveLength(0);
		expect(windows).toHaveLength(1);
		expect(windows[0]!.minDensity).toBe(6);
		expect(windows[0]!.peakOrdinals).toEqual([637, 660]); // sorted, both required
		expect(windows[0]!.kinds).toEqual(["isolated-transient"]);
	});

	it("keeps separate windows for isolated transients far apart, ordered by start", () => {
		const { windows } = clusterIsolatedFocusWindows([iso(97333, 97467, 1462, 0.217), iso(19267, 19267, 289, 0.168)], {
			mergeGapMs: 1000,
			minDensity: 6,
			maxWindows: 4,
			maxPeaks: 8,
		});
		expect(windows.map((w) => w.startMs)).toEqual([19267, 97333]);
	});

	it("caps to the strongest windows and returns the rest as overflow (honest partial, not silently inspected)", () => {
		const { windows, overflow } = clusterIsolatedFocusWindows(
			[iso(1000, 1000, 10, 0.5), iso(5000, 5000, 20, 0.4), iso(9000, 9000, 30, 0.3)],
			{ mergeGapMs: 500, minDensity: 6, maxWindows: 2, maxPeaks: 8 },
		);
		expect(windows).toHaveLength(2);
		// Strongest two windows kept (peakRatio 0.5 and 0.4), ordered by start.
		expect(windows.map((w) => w.peakOrdinals?.[0])).toEqual([10, 20]);
		// The weakest overflows -> caller must force honest partial.
		expect(overflow.map((o) => o.peakOrdinal)).toEqual([30]);
	});

	it("caps by total peaks too, overflowing whole clusters that do not fit", () => {
		const { windows, overflow } = clusterIsolatedFocusWindows(
			[iso(1000, 1000, 10, 0.5), iso(1200, 1200, 11, 0.5), iso(5000, 5000, 20, 0.4)],
			{ mergeGapMs: 500, minDensity: 6, maxWindows: 4, maxPeaks: 2 },
		);
		// First cluster (2 peaks) fits maxPeaks=2; the second cluster overflows.
		expect(windows).toHaveLength(1);
		expect(windows[0]!.peakOrdinals).toEqual([10, 11]);
		expect(overflow.map((o) => o.peakOrdinal)).toEqual([20]);
	});
});
