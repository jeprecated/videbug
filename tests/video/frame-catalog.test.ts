import { beforeAll, describe, expect, it } from "vitest";
import { buildFrameCatalog } from "../../src/video/probe.ts";
import { CFR_FIXTURE, VFR_FIXTURE, ensureFixtures } from "../helpers/fixtures.ts";

beforeAll(async () => {
	await ensureFixtures();
});

describe("buildFrameCatalog (CFR)", () => {
	it("recovers every source frame PTS at exactly 10 fps", async () => {
		const catalog = await buildFrameCatalog(CFR_FIXTURE.path);
		expect(catalog.frames).toHaveLength(CFR_FIXTURE.frameCount);
		expect(catalog.frames.map((f) => f.ptsUs)).toEqual(CFR_FIXTURE.expectedPtsUs);
		expect(catalog.frames.map((f) => f.ordinal)).toEqual(CFR_FIXTURE.expectedPtsUs.map((_, index) => index));
		expect(catalog.frames[0]?.keyFrame).toBe(true);
	});

	it("produces a strictly increasing (monotonic) catalog", async () => {
		const catalog = await buildFrameCatalog(CFR_FIXTURE.path);
		for (let i = 1; i < catalog.frames.length; i++) {
			expect(catalog.frames[i]!.ptsUs).toBeGreaterThan(catalog.frames[i - 1]!.ptsUs);
		}
	});
});

describe("buildFrameCatalog (VFR)", () => {
	it("recovers genuinely non-uniform source PTS without ordinal/rate drift", async () => {
		const catalog = await buildFrameCatalog(VFR_FIXTURE.path);
		expect(catalog.frames).toHaveLength(VFR_FIXTURE.frameCount);
		expect(catalog.frames.map((f) => f.ptsUs)).toEqual(VFR_FIXTURE.expectedPtsUs);
	});

	it("does not derive timestamps from the (misleading) average frame rate", async () => {
		const catalog = await buildFrameCatalog(VFR_FIXTURE.path);
		// avg_frame_rate is 45/7; naive ordinal * (1/avgFps) would place frame 1 at
		// ~155_555us, but the true source PTS is 166_667us. The catalog must carry
		// the true PTS, not the derived one.
		expect(catalog.frames[1]?.ptsUs).toBe(VFR_FIXTURE.expectedPtsUs[1]);
		expect(catalog.frames[1]?.ptsUs).not.toBe(Math.round((1 / (45 / 7)) * 1e6));
	});
});
