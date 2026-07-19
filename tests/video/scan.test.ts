import { beforeAll, describe, expect, it } from "vitest";
import { computeChangeSignals } from "../../src/video/change-signals.ts";
import type { FrameCatalog } from "../../src/video/probe.ts";
import { buildFrameCatalog } from "../../src/video/probe.ts";
import {
	ScanError,
	associateScan,
	chooseScanPolicy,
	scanDimensions,
	scanRecording,
	selectedOrdinals,
	splitRawFrames,
} from "../../src/video/scan.ts";
import {
	CFR_FIXTURE,
	LOCAL_ANIMATION_FIXTURE,
	STATIC_FIXTURE,
	TRANSIENT_FIXTURE,
	ensureFixtures,
} from "../helpers/fixtures.ts";

beforeAll(async () => {
	await ensureFixtures();
});

function fakeCatalog(frameCount: number): FrameCatalog {
	return {
		streamIndex: 0,
		codec: "h264",
		width: 64,
		height: 64,
		timeBase: "1/10240",
		avgFrameRate: "10/1",
		rFrameRate: "10/1",
		frames: Array.from({ length: frameCount }, (_, k) => ({
			ordinal: k,
			ptsUs: k * 100_000,
			keyFrame: k === 0,
			width: 64,
			height: 64,
		})),
	};
}

describe("scanDimensions", () => {
	it("scales the longest side to maxDim, preserving aspect ratio", () => {
		expect(scanDimensions(1920, 1080, 64)).toEqual({ width: 64, height: 36 });
		expect(scanDimensions(1080, 1920, 64)).toEqual({ width: 36, height: 64 });
		expect(scanDimensions(64, 64, 64)).toEqual({ width: 64, height: 64 });
	});

	it("never returns a zero dimension", () => {
		const dims = scanDimensions(1000, 1, 64);
		expect(dims.height).toBeGreaterThanOrEqual(1);
	});
});

describe("chooseScanPolicy", () => {
	it("scans every frame under the safety limit", () => {
		const policy = chooseScanPolicy(500, 30, { frameLimit: 100_000, maxScanFps: 8 });
		expect(policy).toMatchObject({ mode: "full", stride: 1, degraded: false, scannedFrameCount: 500 });
	});

	it("degrades to a capped stride above the safety limit", () => {
		const policy = chooseScanPolicy(200_000, 30, { frameLimit: 100_000, maxScanFps: 8 });
		expect(policy.mode).toBe("strided");
		expect(policy.degraded).toBe(true);
		// 30 / 8 -> ceil = 4
		expect(policy.stride).toBe(4);
		expect(policy.scannedFrameCount).toBe(selectedOrdinals(200_000, 4).length);
	});
});

describe("selectedOrdinals", () => {
	it("selects 0, stride, 2*stride, ...", () => {
		expect(selectedOrdinals(10, 3)).toEqual([0, 3, 6, 9]);
		expect(selectedOrdinals(5, 1)).toEqual([0, 1, 2, 3, 4]);
	});
});

describe("splitRawFrames", () => {
	it("splits a raw buffer into fixed-size gray frames", () => {
		const buf = Buffer.from([1, 2, 3, 4, 5, 6]);
		const frames = splitRawFrames(buf, 2);
		expect(frames.map((f) => [...f])).toEqual([
			[1, 2],
			[3, 4],
			[5, 6],
		]);
	});

	it("fails closed when the buffer is not a whole number of frames", () => {
		expect(() => splitRawFrames(Buffer.from([1, 2, 3]), 2)).toThrow(ScanError);
	});
});

describe("associateScan (fail-closed)", () => {
	const catalog = fakeCatalog(3);
	const dims = { width: 2, height: 1 };

	it("associates scan frames one-for-one with catalog ordinals", () => {
		const raw = [new Uint8Array([1, 1]), new Uint8Array([2, 2]), new Uint8Array([3, 3])];
		const frames = associateScan(catalog, [0, 1, 2], raw, dims);
		expect(frames.map((f) => f.ordinal)).toEqual([0, 1, 2]);
		expect(frames.map((f) => f.ptsUs)).toEqual([0, 100_000, 200_000]);
		expect(frames[0]!.width).toBe(2);
	});

	it("fails closed when the scan frame count diverges from the catalog selection", () => {
		const raw = [new Uint8Array([1, 1]), new Uint8Array([2, 2])];
		expect(() => associateScan(catalog, [0, 1, 2], raw, dims)).toThrow(ScanError);
	});
});

describe("scanRecording (integration)", () => {
	it("scans every CFR source frame one-for-one with the catalog", async () => {
		const catalog = await buildFrameCatalog(CFR_FIXTURE.path);
		const scan = await scanRecording(CFR_FIXTURE.path, catalog);
		expect(scan.policy.mode).toBe("full");
		expect(scan.frames).toHaveLength(catalog.frames.length);
		expect(scan.frames.map((f) => f.ordinal)).toEqual(catalog.frames.map((f) => f.ordinal));
		expect(scan.frames.map((f) => f.ptsUs)).toEqual(catalog.frames.map((f) => f.ptsUs));
		expect(scan.frames[0]!.data.length).toBe(scan.width * scan.height);
	});

	it("honors a degraded stride policy and still associates fail-closed", async () => {
		const catalog = await buildFrameCatalog(CFR_FIXTURE.path);
		// Force the degraded path with a tiny frame limit; 10 fps / 8 -> stride 2.
		const scan = await scanRecording(CFR_FIXTURE.path, catalog, { frameLimit: 5, maxScanFps: 8 });
		expect(scan.policy.mode).toBe("strided");
		expect(scan.policy.degraded).toBe(true);
		expect(scan.frames).toHaveLength(selectedOrdinals(catalog.frames.length, scan.policy.stride).length);
		expect(scan.frames.map((f) => f.ordinal)).toEqual(selectedOrdinals(catalog.frames.length, scan.policy.stride));
	});

	it("detects the long-static run and the hard cut", async () => {
		const catalog = await buildFrameCatalog(STATIC_FIXTURE.path);
		const scan = await scanRecording(STATIC_FIXTURE.path, catalog);
		const signals = computeChangeSignals(scan.frames);
		// Many low-change frames in the static run.
		const lowChange = signals.filter((s) => s.motion === "none" || s.duplicate !== "none").length;
		expect(lowChange).toBeGreaterThan(15);
		// A global cut somewhere around ordinal 20.
		const cut = signals.find((s) => s.motion === "global");
		expect(cut).toBeDefined();
		expect(cut!.ordinal).toBeGreaterThanOrEqual(18);
		expect(cut!.ordinal).toBeLessThanOrEqual(22);
	});

	it("sees the sub-500ms transient flash as high-change frames", async () => {
		const catalog = await buildFrameCatalog(TRANSIENT_FIXTURE.path);
		const scan = await scanRecording(TRANSIENT_FIXTURE.path, catalog);
		const signals = computeChangeSignals(scan.frames);
		const highChange = signals.filter((s) => s.changedPixelRatio > 0.5).map((s) => s.ordinal);
		// The flash turns on (~ordinal 10) and off (~ordinal 13): at least two spikes.
		expect(highChange.length).toBeGreaterThanOrEqual(2);
		expect(highChange.some((o) => o >= 9 && o <= 14)).toBe(true);
	});

	it("sees localized motion in the local-animation fixture", async () => {
		const catalog = await buildFrameCatalog(LOCAL_ANIMATION_FIXTURE.path);
		const scan = await scanRecording(LOCAL_ANIMATION_FIXTURE.path, catalog);
		const signals = computeChangeSignals(scan.frames);
		const local = signals.filter((s) => s.motion === "local").length;
		const global = signals.filter((s) => s.motion === "global").length;
		expect(local).toBeGreaterThan(global);
		expect(local).toBeGreaterThanOrEqual(5);
	});
});
