import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { buildFrameCatalog } from "../../src/video/probe.ts";
import { fingerprintSource, sourceFromCatalog } from "../../src/video/source.ts";
import { CFR_FIXTURE, ensureFixtures } from "../helpers/fixtures.ts";

beforeAll(async () => {
	await ensureFixtures();
});

describe("sourceFromCatalog (pure)", () => {
	it("derives the deterministic source fingerprint fields from a catalog", () => {
		const catalog = {
			streamIndex: 2,
			codec: "h264",
			width: 1920,
			height: 1080,
			timeBase: "1/15360",
			avgFrameRate: "30/1",
			rFrameRate: "30/1",
			durationMs: 2000,
			frames: [
				{ ordinal: 0, ptsUs: 0, keyFrame: true, width: 1920, height: 1080 },
				{ ordinal: 1, ptsUs: 33_333, keyFrame: false, width: 1920, height: 1080 },
			],
		};
		const source = sourceFromCatalog("/tmp/My Recording.mp4", "a".repeat(64), catalog);
		expect(source).toEqual({
			basename: "My Recording.mp4",
			sha256: "a".repeat(64),
			durationMs: 2000,
			width: 1920,
			height: 1080,
			streamIndex: 2,
			averageFps: 30,
		});
	});

	it("falls back to frames/duration when avg_frame_rate is absent", () => {
		const catalog = {
			streamIndex: 0,
			codec: "h264",
			width: 64,
			height: 64,
			timeBase: "1/10240",
			avgFrameRate: "",
			rFrameRate: "",
			durationMs: 1000,
			frames: [
				{ ordinal: 0, ptsUs: 0, keyFrame: true, width: 64, height: 64 },
				{ ordinal: 1, ptsUs: 500_000, keyFrame: false, width: 64, height: 64 },
				{ ordinal: 2, ptsUs: 1_000_000, keyFrame: false, width: 64, height: 64 },
			],
		};
		const source = sourceFromCatalog("clip.mp4", "b".repeat(64), catalog);
		expect(source.averageFps).toBeCloseTo(2, 5);
	});
});

describe("fingerprintSource (integration)", () => {
	it("streams the real file's sha256 and reads real dimensions", async () => {
		const catalog = await buildFrameCatalog(CFR_FIXTURE.path);
		const source = await fingerprintSource(CFR_FIXTURE.path, catalog);
		const expected = createHash("sha256").update(readFileSync(CFR_FIXTURE.path)).digest("hex");
		expect(source.sha256).toBe(expected);
		expect(source.width).toBe(64);
		expect(source.height).toBe(64);
		expect(source.basename).toBe("cfr-10fps.mp4");
		expect(source.averageFps).toBeCloseTo(10, 5);
		expect(source.durationMs).toBeGreaterThan(0);
	});
});
