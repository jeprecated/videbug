import { describe, expect, it } from "vitest";
import { detectHiddenTransients } from "../../src/video/degraded-rescan.ts";
import type { FrameCatalog } from "../../src/video/probe.ts";

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

const catalog = fakeCatalog(6);

describe("detectHiddenTransients", () => {
	it("recovers a sub-stride flash that the strided pass skipped between stable samples", () => {
		// stride 2 sampled even ordinals; a one-frame flash lands on odd ordinal 3.
		const activity = [
			{ ordinal: 0, ratio: 0 },
			{ ordinal: 1, ratio: 0 },
			{ ordinal: 2, ratio: 0 },
			{ ordinal: 3, ratio: 0.9 }, // flash appears (vs frame 2)
			{ ordinal: 4, ratio: 0.9 }, // flash disappears (vs frame 3)
			{ ordinal: 5, ratio: 0 },
		];
		const hidden = detectHiddenTransients({
			activity,
			sampledOrdinals: [0, 2, 4],
			stableSampledOrdinals: new Set([0, 2, 4]),
			catalog,
		});
		expect(hidden).toHaveLength(1);
		expect(hidden[0]!.kind).toBe("transient");
		expect(hidden[0]!.representativeOrdinal).toBe(3);
		expect(hidden[0]!.startOrdinal).toBe(2);
		expect(hidden[0]!.endOrdinal).toBe(4);
		expect(hidden[0]!.startPtsUs).toBe(200_000);
		expect(hidden[0]!.endPtsUs).toBe(400_000);
	});

	it("does not flag activity on a sampled ordinal (the strided pass already saw it)", () => {
		const activity = [
			{ ordinal: 0, ratio: 0 },
			{ ordinal: 1, ratio: 0 },
			{ ordinal: 2, ratio: 0.9 }, // sampled ordinal — visible to the strided pass
			{ ordinal: 3, ratio: 0 },
			{ ordinal: 4, ratio: 0 },
			{ ordinal: 5, ratio: 0 },
		];
		const hidden = detectHiddenTransients({
			activity,
			sampledOrdinals: [0, 2, 4],
			stableSampledOrdinals: new Set([0, 2, 4]),
			catalog,
		});
		expect(hidden).toHaveLength(0);
	});

	it("does not flag when a bracketing sample was already non-stable (real boundary, not hidden)", () => {
		const activity = [
			{ ordinal: 0, ratio: 0 },
			{ ordinal: 1, ratio: 0 },
			{ ordinal: 2, ratio: 0 },
			{ ordinal: 3, ratio: 0.9 },
			{ ordinal: 4, ratio: 0.9 },
			{ ordinal: 5, ratio: 0 },
		];
		const hidden = detectHiddenTransients({
			activity,
			sampledOrdinals: [0, 2, 4],
			// Sample 4 is NOT stable: the strided pass already flagged change there.
			stableSampledOrdinals: new Set([0, 2]),
			catalog,
		});
		expect(hidden).toHaveLength(0);
	});

	it("returns nothing when there is no sub-stride activity", () => {
		const activity = catalog.frames.map((f) => ({ ordinal: f.ordinal, ratio: 0 }));
		const hidden = detectHiddenTransients({
			activity,
			sampledOrdinals: [0, 2, 4],
			stableSampledOrdinals: new Set([0, 2, 4]),
			catalog,
		});
		expect(hidden).toEqual([]);
	});
});
