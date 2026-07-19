import { describe, expect, it } from "vitest";
import type { ChangeSignal, Duplicate, Motion } from "../../src/video/change-signals.ts";
import { detectIsolatedTransients } from "../../src/video/isolated-transients.ts";

/** A near-featureless (blank) background difference-hash (0 bits set). */
const BLANK = 0n;
/** A busy, high-complexity background difference-hash (many bits set). */
const BUSY = 0xff_ff_ff_ff_ff_ff_ff_ffn;

/** Minimal ChangeSignal factory; only the fields the detector reads matter. */
function sig(
	ordinal: number,
	ratio: number,
	motion: Motion,
	duplicate: Duplicate = "none",
	dHash: bigint = BLANK,
): ChangeSignal {
	return {
		ordinal,
		ptsUs: ordinal * 66_667,
		absDiffMean: ratio * 255,
		changedPixelRatio: ratio,
		dHash,
		dHashDistance: 0,
		grid: [],
		changedCells: motion === "global" ? 40 : motion === "local" ? 4 : 0,
		motion,
		duplicate,
	};
}

const bg = (o: number): ChangeSignal => sig(o, 0.002, "none", "near", BLANK);
/** A busy (high-complexity) held-background frame. */
const busyBg = (o: number): ChangeSignal => sig(o, 0.002, "none", "near", BUSY);
const busySpan = (from: number, to: number): ChangeSignal[] => {
	const out: ChangeSignal[] = [];
	for (let o = from; o <= to; o++) out.push(busyBg(o));
	return out;
};
const bgSpan = (from: number, to: number): ChangeSignal[] => {
	const out: ChangeSignal[] = [];
	for (let o = from; o <= to; o++) out.push(bg(o));
	return out;
};
/** A localised flash frame (partial-frame change), the overlay/text/toast shape. */
const flash = (o: number, ratio: number): ChangeSignal => sig(o, ratio, "local");

describe("detectIsolatedTransients", () => {
	it("detects a LOCAL text/overlay flash and reads the interior HELD frame (leaked-string shape)", () => {
		const signals = [
			...bgSpan(0, 9), // long stable background
			flash(10, 0.22), // text renders (local change into the state)
			bg(11), // text HELD (static) — the frame to READ
			flash(12, 0.2), // text clears (change out to next screen)
			...bgSpan(13, 22), // background returns
		];
		const found = detectIsolatedTransients(signals);
		expect(found).toHaveLength(1);
		expect(found[0]!.startOrdinal).toBe(10);
		expect(found[0]!.endOrdinal).toBe(12);
		// Read the interior HELD frame (11), not the change boundary (12).
		expect(found[0]!.peakOrdinal).toBe(11);
		expect(found[0]!.peakPtsUs).toBe(11 * 66_667);
	});

	it("detects a single-frame local flash", () => {
		const signals = [...bgSpan(0, 5), flash(6, 0.3), ...bgSpan(7, 13)];
		const found = detectIsolatedTransients(signals);
		expect(found).toHaveLength(1);
		expect(found[0]!.peakOrdinal).toBe(6);
	});

	it("does NOT promote a PERMANENT whole-frame scene cut (global peak)", () => {
		const signals = [...bgSpan(0, 9), sig(10, 0.6, "global"), ...bgSpan(11, 20)];
		expect(detectIsolatedTransients(signals)).toHaveLength(0);
	});

	it("does NOT promote a busy cluster of flashes (no stable flanks)", () => {
		const signals = [
			...bgSpan(0, 1),
			flash(2, 0.3),
			bg(3),
			flash(4, 0.3),
			bg(5),
			flash(6, 0.3),
			bg(7),
			flash(8, 0.3),
			...bgSpan(9, 10),
		];
		expect(detectIsolatedTransients(signals)).toHaveLength(0);
	});

	it("does NOT promote a sustained local change longer than a brief island", () => {
		const dev: ChangeSignal[] = [];
		for (let o = 4; o <= 16; o++) dev.push(flash(o, 0.3));
		const signals = [...bgSpan(0, 3), ...dev, ...bgSpan(17, 24)];
		expect(detectIsolatedTransients(signals)).toHaveLength(0);
	});

	it("does NOT promote a flash at the very start (no stable flank before)", () => {
		const signals = [flash(0, 0.3), bg(1), flash(2, 0.3), ...bgSpan(3, 10)];
		expect(detectIsolatedTransients(signals)).toHaveLength(0);
	});

	it("ranks multiple isolated transients by peak change desc, then ordinal asc", () => {
		const signals = [
			...bgSpan(0, 5),
			flash(6, 0.25), // weaker
			...bgSpan(7, 14),
			flash(15, 0.6), // stronger
			...bgSpan(16, 23),
		];
		const found = detectIsolatedTransients(signals);
		expect(found).toHaveLength(2);
		expect(found[0]!.peakOrdinal).toBe(15);
		expect(found[1]!.peakOrdinal).toBe(6);
	});

	it("ignores a low-contrast flicker below the recording's high percentile", () => {
		const strong: ChangeSignal[] = [];
		for (let o = 0; o <= 60; o++) strong.push(o % 10 === 5 ? flash(o, 0.5) : bg(o));
		const weak = [...bgSpan(61, 66), flash(67, 0.01), ...bgSpan(68, 74)];
		const found = detectIsolatedTransients([...strong, ...weak]);
		expect(found.every((t) => t.peakOrdinal !== 67)).toBe(true);
	});

	it("does NOT promote an isolated flash against a BUSY (high-complexity) background (ordinary UI churn)", () => {
		// Short, isolated, high-peak, local — but both flanks are busy (streaming-text UI).
		const signals = [...busySpan(0, 9), sig(10, 0.3, "local", "none", BUSY), ...busySpan(11, 20)];
		expect(detectIsolatedTransients(signals)).toHaveLength(0);
	});

	it("reads the interior held frame nearest the island centre within a multi-frame island", () => {
		const signals = [
			...bgSpan(0, 5),
			flash(6, 0.18),
			bg(7), // interior held frame (centre) -> READ
			flash(8, 0.44), // strongest change (ranking key only)
			bg(9),
			...bgSpan(10, 16),
		];
		const found = detectIsolatedTransients(signals);
		expect(found).toHaveLength(1);
		expect(found[0]!.startOrdinal).toBe(6);
		expect(found[0]!.endOrdinal).toBe(8);
		expect(found[0]!.peakOrdinal).toBe(7); // interior held frame, not the max-change frame
		expect(found[0]!.peakRatio).toBeCloseTo(0.44, 5); // ranking key stays the strongest change
	});
});
