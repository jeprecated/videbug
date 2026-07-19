import { describe, expect, it } from "vitest";
import { buildCandidates } from "../../src/video/candidates.ts";
import type { ChangeSignal, Duplicate, Motion } from "../../src/video/change-signals.ts";

/** Build a minimal ChangeSignal for candidate tests without running a scan. */
function sig(
	ordinal: number,
	motion: Motion,
	opts: { changedPixelRatio?: number; duplicate?: Duplicate; dHashDistance?: number } = {},
): ChangeSignal {
	return {
		ordinal,
		ptsUs: ordinal * 100_000,
		absDiffMean: motion === "global" ? 120 : motion === "local" ? 10 : 0,
		changedPixelRatio: opts.changedPixelRatio ?? (motion === "global" ? 0.8 : motion === "local" ? 0.05 : 0),
		dHash: 0n,
		dHashDistance: opts.dHashDistance ?? (motion === "global" ? 30 : 0),
		grid: new Array<number>(64).fill(0),
		changedCells: motion === "global" ? 40 : motion === "local" ? 2 : 0,
		motion,
		duplicate: opts.duplicate ?? (motion === "none" ? "exact" : "none"),
	};
}

function stableRun(start: number, length: number): ChangeSignal[] {
	return Array.from({ length }, (_, k) => sig(start + k, "none", { duplicate: "exact" }));
}

describe("buildCandidates", () => {
	it("returns no candidates for an empty or single-frame series", () => {
		expect(buildCandidates([])).toEqual([]);
		expect(buildCandidates([sig(0, "none")])).toEqual([]);
	});

	it("detects a stable window across a long low-change run", () => {
		const signals = [sig(0, "none"), ...stableRun(1, 20)];
		const stable = buildCandidates(signals).filter((c) => c.kind === "stable");
		expect(stable.length).toBeGreaterThanOrEqual(1);
		const window = stable[0]!;
		expect(window.endOrdinal - window.startOrdinal).toBeGreaterThanOrEqual(10);
		expect(window.representativeOrdinal).toBeGreaterThanOrEqual(window.startOrdinal);
		expect(window.representativeOrdinal).toBeLessThanOrEqual(window.endOrdinal);
	});

	it("detects a boundary window at a global-motion transition", () => {
		const signals = [...stableRun(0, 6), sig(6, "global"), ...stableRun(7, 6)];
		const boundaries = buildCandidates(signals).filter((c) => c.kind === "boundary");
		expect(boundaries.length).toBeGreaterThanOrEqual(1);
		expect(boundaries.some((b) => b.startOrdinal <= 6 && b.endOrdinal >= 6)).toBe(true);
	});

	it("merges adjacent global-motion frames into a single boundary window", () => {
		const signals = [...stableRun(0, 4), sig(4, "global"), sig(5, "global"), sig(6, "global"), ...stableRun(7, 4)];
		const boundaries = buildCandidates(signals).filter((c) => c.kind === "boundary");
		expect(boundaries).toHaveLength(1);
		expect(boundaries[0]!.startOrdinal).toBe(4);
		expect(boundaries[0]!.endOrdinal).toBe(6);
	});

	it("detects a short transient burst as a transient window bounded by stability", () => {
		const signals = [...stableRun(0, 8), sig(8, "global"), ...stableRun(9, 8)];
		const transients = buildCandidates(signals).filter((c) => c.kind === "transient");
		expect(transients.length).toBeGreaterThanOrEqual(1);
		expect(transients[0]!.startOrdinal).toBeLessThanOrEqual(8);
		expect(transients[0]!.endOrdinal).toBeGreaterThanOrEqual(8);
	});

	it("detects a brief LOCALIZED transient (not a global cut) bounded by stability", () => {
		// A small element flashes for one frame: local motion, not global. It must
		// still surface as a transient candidate, not be swallowed as noise.
		const signals = [...stableRun(0, 8), sig(8, "local"), ...stableRun(9, 8)];
		const candidates = buildCandidates(signals);
		const transients = candidates.filter((c) => c.kind === "transient");
		expect(transients.some((t) => t.startOrdinal <= 8 && t.endOrdinal >= 8)).toBe(true);
		// A single local frame is too short to be a sustained local-animation window.
		expect(candidates.some((c) => c.kind === "local-animation")).toBe(false);
	});

	it("does not report a sustained local-animation run as a transient", () => {
		const anim = Array.from({ length: 12 }, (_, k) => sig(1 + k, "local"));
		const signals = [sig(0, "none"), ...anim, ...stableRun(13, 4)];
		const transients = buildCandidates(signals).filter((c) => c.kind === "transient");
		expect(transients).toHaveLength(0);
	});

	it("detects a local-animation window across a run of localized motion", () => {
		const anim = Array.from({ length: 12 }, (_, k) => sig(1 + k, "local"));
		const signals = [sig(0, "none"), ...anim];
		const local = buildCandidates(signals).filter((c) => c.kind === "local-animation");
		expect(local.length).toBeGreaterThanOrEqual(1);
		expect(local[0]!.endOrdinal - local[0]!.startOrdinal).toBeGreaterThanOrEqual(8);
	});

	it("ranks candidates deterministically (score desc, then startOrdinal asc)", () => {
		const signals = [...stableRun(0, 30), sig(30, "global"), ...stableRun(31, 5)];
		const candidates = buildCandidates(signals);
		for (let i = 1; i < candidates.length; i++) {
			const prev = candidates[i - 1]!;
			const cur = candidates[i]!;
			const ordered = prev.score > cur.score || (prev.score === cur.score && prev.startOrdinal <= cur.startOrdinal);
			expect(ordered).toBe(true);
		}
	});
});
