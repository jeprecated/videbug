import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractExactFrames, verifyExtraction } from "../../src/video/extract.ts";
import { buildFrameCatalog } from "../../src/video/probe.ts";
import { CFR_FIXTURE, VFR_FIXTURE, ensureFixtures } from "../helpers/fixtures.ts";

beforeAll(async () => {
	await ensureFixtures();
});

function tempOut(): string {
	return mkdtempSync(join(tmpdir(), "v2d-extract-"));
}

describe("extractExactFrames (CFR)", () => {
	it("extracts requested ordinals with exact source PTS and no drift", async () => {
		const catalog = await buildFrameCatalog(CFR_FIXTURE.path);
		const ordinals = [0, 5, 19];
		const result = await extractExactFrames(CFR_FIXTURE.path, ordinals, catalog, tempOut());

		expect(result.frames).toHaveLength(3);
		expect(result.frames.map((f) => f.requestedOrdinal)).toEqual([0, 5, 19]);
		expect(result.frames.map((f) => f.ptsUs)).toEqual([0, 500_000, 1_900_000]);
		for (const frame of result.frames) {
			expect(frame.width).toBe(64);
			expect(frame.height).toBe(64);
		}
	});
});

describe("extractExactFrames (VFR)", () => {
	it("extracts irregular source frames with exact PTS", async () => {
		const catalog = await buildFrameCatalog(VFR_FIXTURE.path);
		// ordinals 0,3,5 -> source PTS 0, 0.666667s, 2.666667s
		const result = await extractExactFrames(VFR_FIXTURE.path, [0, 3, 5], catalog, tempOut());

		expect(result.frames.map((f) => f.ptsUs)).toEqual([
			catalog.frames[0]!.ptsUs,
			catalog.frames[3]!.ptsUs,
			catalog.frames[5]!.ptsUs,
		]);
		expect(result.frames.map((f) => f.ptsUs)).toEqual([0, 666_667, 2_666_667]);
	});

	it("sorts and de-duplicates requested ordinals but preserves chronological output", async () => {
		const catalog = await buildFrameCatalog(VFR_FIXTURE.path);
		const result = await extractExactFrames(VFR_FIXTURE.path, [5, 0, 3, 0], catalog, tempOut());
		expect(result.frames.map((f) => f.requestedOrdinal)).toEqual([0, 3, 5]);
		expect(result.frames.map((f) => f.ptsUs)).toEqual([0, 666_667, 2_666_667]);
	});
});

describe("verifyExtraction (fail-closed)", () => {
	it("accepts an exact, ordered, unique extraction", () => {
		const catalog = {
			streamIndex: 0,
			codec: "h264",
			width: 64,
			height: 64,
			timeBase: "1/15360",
			avgFrameRate: "10/1",
			rFrameRate: "10/1",
			frames: [
				{ ordinal: 0, ptsUs: 0, keyFrame: true, width: 64, height: 64 },
				{ ordinal: 1, ptsUs: 100_000, keyFrame: false, width: 64, height: 64 },
				{ ordinal: 2, ptsUs: 200_000, keyFrame: false, width: 64, height: 64 },
			],
		};
		const result = verifyExtraction([0, 2], catalog, [
			{ requestedOrdinal: 0, ptsUs: 0, width: 64, height: 64, path: "a.png" },
			{ requestedOrdinal: 2, ptsUs: 200_000, width: 64, height: 64, path: "c.png" },
		]);
		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("fails closed on a count mismatch (dropped frame)", () => {
		const catalog = {
			streamIndex: 0,
			codec: "h264",
			width: 64,
			height: 64,
			timeBase: "1/15360",
			avgFrameRate: "10/1",
			rFrameRate: "10/1",
			frames: [
				{ ordinal: 0, ptsUs: 0, keyFrame: true, width: 64, height: 64 },
				{ ordinal: 1, ptsUs: 100_000, keyFrame: false, width: 64, height: 64 },
			],
		};
		const result = verifyExtraction([0, 1], catalog, [
			{ requestedOrdinal: 0, ptsUs: 0, width: 64, height: 64, path: "a.png" },
		]);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toMatch(/count/i);
	});

	it("fails closed on a duplicated output PTS (CFR-style inflation)", () => {
		const catalog = {
			streamIndex: 0,
			codec: "h264",
			width: 64,
			height: 64,
			timeBase: "1/15360",
			avgFrameRate: "10/1",
			rFrameRate: "10/1",
			frames: [
				{ ordinal: 0, ptsUs: 0, keyFrame: true, width: 64, height: 64 },
				{ ordinal: 1, ptsUs: 100_000, keyFrame: false, width: 64, height: 64 },
			],
		};
		const result = verifyExtraction([0, 1], catalog, [
			{ requestedOrdinal: 0, ptsUs: 0, width: 64, height: 64, path: "a.png" },
			{ requestedOrdinal: 1, ptsUs: 0, width: 64, height: 64, path: "b.png" },
		]);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toMatch(/duplicate|order/i);
	});

	it("fails closed on ordinal->PTS drift", () => {
		const catalog = {
			streamIndex: 0,
			codec: "h264",
			width: 64,
			height: 64,
			timeBase: "1/15360",
			avgFrameRate: "10/1",
			rFrameRate: "10/1",
			frames: [
				{ ordinal: 0, ptsUs: 0, keyFrame: true, width: 64, height: 64 },
				{ ordinal: 1, ptsUs: 100_000, keyFrame: false, width: 64, height: 64 },
				{ ordinal: 2, ptsUs: 200_000, keyFrame: false, width: 64, height: 64 },
			],
		};
		// Requested ordinal 2 (PTS 200_000) but the output carries PTS 100_000.
		const result = verifyExtraction([0, 2], catalog, [
			{ requestedOrdinal: 0, ptsUs: 0, width: 64, height: 64, path: "a.png" },
			{ requestedOrdinal: 2, ptsUs: 100_000, width: 64, height: 64, path: "c.png" },
		]);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toMatch(/drift|mismatch|pts/i);
	});
});
