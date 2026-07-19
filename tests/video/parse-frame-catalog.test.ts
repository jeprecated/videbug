import { describe, expect, it } from "vitest";
import { FrameCatalogError, parseFrameCatalog } from "../../src/video/probe.ts";

const stream = {
	index: 0,
	codec_name: "h264",
	width: 64,
	height: 64,
	avg_frame_rate: "10/1",
	r_frame_rate: "10/1",
	time_base: "1/10240",
};

describe("parseFrameCatalog (pure, no ffprobe)", () => {
	it("builds a monotonic catalog from decoded frames with microsecond PTS", () => {
		const catalog = parseFrameCatalog({
			stream,
			frames: [
				{ best_effort_timestamp_time: "0", key_frame: 1 },
				{ best_effort_timestamp_time: "0.1", key_frame: 0 },
				{ best_effort_timestamp_time: "0.2", key_frame: 0 },
			],
			formatDuration: "0.3",
		});
		expect(catalog.frames.map((f) => f.ptsUs)).toEqual([0, 100_000, 200_000]);
		expect(catalog.frames.map((f) => f.ordinal)).toEqual([0, 1, 2]);
		expect(catalog.frames[0]?.keyFrame).toBe(true);
		expect(catalog.durationMs).toBe(300);
	});

	it("rejects a frame with a missing best_effort_timestamp_time (fail closed)", () => {
		expect(() =>
			parseFrameCatalog({
				stream,
				frames: [{ best_effort_timestamp_time: "0", key_frame: 1 }, { key_frame: 0 }],
			}),
		).toThrow(FrameCatalogError);
	});

	it("rejects a frame whose timestamp is the literal N/A", () => {
		expect(() =>
			parseFrameCatalog({
				stream,
				frames: [
					{ best_effort_timestamp_time: "0", key_frame: 1 },
					{ best_effort_timestamp_time: "N/A", key_frame: 0 },
				],
			}),
		).toThrow(/timestamp/i);
	});

	it("rejects a non-monotonic catalog (PTS regresses)", () => {
		expect(() =>
			parseFrameCatalog({
				stream,
				frames: [
					{ best_effort_timestamp_time: "0", key_frame: 1 },
					{ best_effort_timestamp_time: "0.2", key_frame: 0 },
					{ best_effort_timestamp_time: "0.1", key_frame: 0 },
				],
			}),
		).toThrow(/non-monotonic/i);
	});

	it("rejects an empty frame list", () => {
		expect(() => parseFrameCatalog({ stream, frames: [] })).toThrow(FrameCatalogError);
	});
});
