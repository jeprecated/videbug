import { describe, expect, it } from "vitest";
import { resolveRangeOrdinals } from "../../src/evidence/range.ts";

// 20 frames at 10fps: ordinal k has PTS k*100ms.
const catalog = {
	frames: Array.from({ length: 20 }, (_, k) => ({
		ordinal: k,
		ptsUs: k * 100_000,
		keyFrame: false,
		width: 64,
		height: 64,
	})),
};

describe("resolveRangeOrdinals", () => {
	it("resolves requested ms window to in-window source ordinals", () => {
		const { ordinals, resolvedStartMs, resolvedEndMs } = resolveRangeOrdinals(catalog, 500, 900, 5);
		expect(ordinals).toEqual([5, 6, 7, 8, 9]);
		expect(resolvedStartMs).toBe(500);
		expect(resolvedEndMs).toBe(900);
	});

	it("samples evenly, always including first and last in-window frame", () => {
		const { ordinals } = resolveRangeOrdinals(catalog, 0, 900, 3);
		expect(ordinals[0]).toBe(0);
		expect(ordinals[ordinals.length - 1]).toBe(9);
		expect(ordinals.length).toBeLessThanOrEqual(3);
	});

	it("returns all in-window frames when samples exceeds availability", () => {
		const { ordinals } = resolveRangeOrdinals(catalog, 300, 500, 50);
		expect(ordinals).toEqual([3, 4, 5]);
	});

	it("returns the nearest frame when the window contains none", () => {
		// Between frames 4 (400ms) and 5 (500ms): a collapsed 450..455ms window.
		const { ordinals } = resolveRangeOrdinals(catalog, 450, 455, 4);
		expect(ordinals.length).toBe(1);
		expect([4, 5]).toContain(ordinals[0]);
	});

	it("normalizes a reversed window", () => {
		const { ordinals } = resolveRangeOrdinals(catalog, 700, 500, 3);
		expect(ordinals[0]).toBe(5);
		expect(ordinals[ordinals.length - 1]).toBe(7);
	});

	it("handles an empty catalog", () => {
		expect(resolveRangeOrdinals({ frames: [] }, 0, 1000, 4).ordinals).toEqual([]);
	});
});
