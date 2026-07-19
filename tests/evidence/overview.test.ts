import { describe, expect, it } from "vitest";
import { selectOverviewOrdinals } from "../../src/evidence/overview.ts";
import type { CandidateWindow } from "../../src/video/candidates.ts";

function boundary(representativeOrdinal: number, score: number): CandidateWindow {
	return {
		kind: "boundary",
		startOrdinal: representativeOrdinal,
		endOrdinal: representativeOrdinal,
		startPtsUs: representativeOrdinal * 100_000,
		endPtsUs: representativeOrdinal * 100_000,
		score,
		representativeOrdinal,
	};
}

function windowOf(kind: CandidateWindow["kind"], representativeOrdinal: number, score: number): CandidateWindow {
	return { ...boundary(representativeOrdinal, score), kind };
}

describe("selectOverviewOrdinals", () => {
	it("always includes the first and final source frames", () => {
		const ordinals = selectOverviewOrdinals({ frameCount: 100, candidates: [] });
		expect(ordinals[0]).toBe(0);
		expect(ordinals[ordinals.length - 1]).toBe(99);
	});

	it("is deterministic and chronologically ordered with no duplicates", () => {
		const candidates = [boundary(40, 1100), windowOf("transient", 41, 950), windowOf("stable", 42, 30)];
		const a = selectOverviewOrdinals({ frameCount: 100, candidates });
		const b = selectOverviewOrdinals({ frameCount: 100, candidates });
		expect(a).toEqual(b);
		expect([...a].sort((x, y) => x - y)).toEqual(a);
		expect(new Set(a).size).toBe(a.length);
	});

	it("includes strong boundary and transient representatives", () => {
		const candidates = [boundary(37, 1200), windowOf("transient", 63, 980)];
		const ordinals = selectOverviewOrdinals({ frameCount: 200, candidates }, { uniformAnchors: 4 });
		expect(ordinals).toContain(37);
		expect(ordinals).toContain(63);
	});

	it("prefers the highest-scoring windows when capped", () => {
		const candidates = Array.from({ length: 40 }, (_, i) => boundary(i + 5, 2000 - i));
		const ordinals = selectOverviewOrdinals({ frameCount: 500, candidates }, { maxBoundaries: 3, uniformAnchors: 2 });
		// The three highest-scoring boundaries are ordinals 5,6,7.
		expect(ordinals).toContain(5);
		expect(ordinals).toContain(6);
		expect(ordinals).toContain(7);
		expect(ordinals).not.toContain(20);
	});

	it("caps the total while preserving endpoints", () => {
		const candidates = Array.from({ length: 80 }, (_, i) => boundary(i + 1, 3000 - i));
		const ordinals = selectOverviewOrdinals({ frameCount: 300, candidates }, { maxCells: 10 });
		expect(ordinals.length).toBeLessThanOrEqual(10);
		expect(ordinals[0]).toBe(0);
		expect(ordinals[ordinals.length - 1]).toBe(299);
	});

	it("handles degenerate frame counts", () => {
		expect(selectOverviewOrdinals({ frameCount: 0, candidates: [] })).toEqual([]);
		expect(selectOverviewOrdinals({ frameCount: 1, candidates: [] })).toEqual([0]);
	});

	it("always includes protected ordinals even past the cell cap", () => {
		const candidates = Array.from({ length: 80 }, (_, i) => boundary(i + 1, 3000 - i));
		const ordinals = selectOverviewOrdinals(
			{ frameCount: 300, candidates, protectedOrdinals: [660, 1462 % 300, 289] },
			{ maxCells: 10 },
		);
		expect(ordinals).toContain(289);
		expect(ordinals).toContain(clampToRange(660, 300));
		// still sorted, unique
		expect([...ordinals].sort((a, b) => a - b)).toEqual(ordinals);
		expect(new Set(ordinals).size).toBe(ordinals.length);
	});
});

function clampToRange(value: number, frameCount: number): number {
	return Math.min(frameCount - 1, Math.max(0, value));
}
