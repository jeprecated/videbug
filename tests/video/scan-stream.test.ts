import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ScanError, consumeRawFrameStream } from "../../src/video/scan.ts";

/** A Readable that yields the given chunks, optionally with async gaps. */
function streamOf(chunks: Buffer[]): Readable {
	return Readable.from(
		(async function* () {
			for (const chunk of chunks) {
				await Promise.resolve();
				yield chunk;
			}
		})(),
	);
}

describe("consumeRawFrameStream (bounded-memory frame splitter)", () => {
	it("splits a chunked byte stream into fixed-size frames in order", async () => {
		// Frame size 2; deliberately split frames across chunk boundaries.
		const chunks = [Buffer.from([1]), Buffer.from([1, 2, 2, 3]), Buffer.from([3])];
		const frames: number[][] = [];
		const count = await consumeRawFrameStream({
			stream: streamOf(chunks),
			frameSize: 2,
			onFrame: (data) => {
				frames.push([...data]);
			},
		});
		expect(count).toBe(3);
		expect(frames).toEqual([
			[1, 1],
			[2, 2],
			[3, 3],
		]);
	});

	it("fails closed when the stream ends mid-frame (partial frame)", async () => {
		await expect(
			consumeRawFrameStream({
				stream: streamOf([Buffer.from([1, 2, 3])]),
				frameSize: 2,
				onFrame: () => {},
			}),
		).rejects.toBeInstanceOf(ScanError);
	});

	it("fails closed when the decoded frame count diverges from the expected count", async () => {
		await expect(
			consumeRawFrameStream({
				stream: streamOf([Buffer.from([1, 1, 2, 2])]),
				frameSize: 2,
				expectedCount: 3,
				onFrame: () => {},
			}),
		).rejects.toThrow(/mismatch/i);
	});

	it("applies backpressure: awaits a slow async consumer and never overlaps frames", async () => {
		const chunks = Array.from({ length: 50 }, (_, k) => Buffer.from([k & 0xff, k & 0xff]));
		let inFlight = 0;
		let maxInFlight = 0;
		const seen: number[] = [];
		await consumeRawFrameStream({
			stream: streamOf(chunks),
			frameSize: 2,
			onFrame: async (_data, index) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 0));
				seen.push(index);
				inFlight--;
			},
		});
		expect(seen).toEqual(Array.from({ length: 50 }, (_, k) => k));
		// Serialized consumption: at most one frame is ever in flight (bounded memory).
		expect(maxInFlight).toBe(1);
	});

	it("stops processing promptly when the signal is aborted", async () => {
		const controller = new AbortController();
		const chunks = Array.from({ length: 100 }, () => Buffer.from([9, 9]));
		let processed = 0;
		const count = await consumeRawFrameStream({
			stream: streamOf(chunks),
			frameSize: 2,
			signal: controller.signal,
			onFrame: () => {
				processed++;
				if (processed === 3) controller.abort();
			},
		});
		// It halts near the abort point rather than draining all 100 frames.
		expect(count).toBeLessThan(100);
		expect(processed).toBeLessThanOrEqual(10);
	});
});
