import { describe, expect, it } from "vitest";
import {
	EVIDENCE_ID_PATTERN,
	EvidenceIdError,
	formatEvidenceId,
	parseEvidenceId,
} from "../../src/evidence/evidence-id.ts";

describe("formatEvidenceId", () => {
	it("produces the documented stable ID shape (fixed-width ordinal and pts-ms)", () => {
		const id = formatEvidenceId({ streamIndex: 0, ordinal: 842, ptsUs: 57_500_000, contentDigest: "2c91a7deadbeef" });
		expect(id).toBe("v0_f000000842_p000057500_2c91a7");
		expect(EVIDENCE_ID_PATTERN.test(id)).toBe(true);
	});

	it("zero-pads ordinal (9) and pts-ms (9) and truncates the digest to 6 hex", () => {
		const id = formatEvidenceId({ streamIndex: 3, ordinal: 5, ptsUs: 1_000, contentDigest: "abcdef123456" });
		// ptsUs 1000 -> 1 ms
		expect(id).toBe("v3_f000000005_p000000001_abcdef");
	});

	it("rounds PTS microseconds to the nearest millisecond", () => {
		expect(formatEvidenceId({ streamIndex: 0, ordinal: 0, ptsUs: 1_499, contentDigest: "aaaaaa" })).toContain(
			"p000000001",
		);
		expect(formatEvidenceId({ streamIndex: 0, ordinal: 0, ptsUs: 1_500, contentDigest: "aaaaaa" })).toContain(
			"p000000002",
		);
	});

	it("represents timestamps well beyond 999.999s without overflow", () => {
		// 1h 1m 1.5s = 3661.5s = 3_661_500 ms, which overflows the old 6-digit field.
		const id = formatEvidenceId({ streamIndex: 0, ordinal: 500_000, ptsUs: 3_661_500_000, contentDigest: "0f0f0f" });
		expect(id).toBe("v0_f000500000_p003661500_0f0f0f");
		expect(EVIDENCE_ID_PATTERN.test(id)).toBe(true);
		expect(parseEvidenceId(id)?.ptsMs).toBe(3_661_500);
	});

	it("fails closed rather than emit an unsortable/unparseable ID on field overflow", () => {
		expect(() =>
			formatEvidenceId({ streamIndex: 0, ordinal: 1_000_000_000, ptsUs: 0, contentDigest: "aaaaaa" }),
		).toThrow(EvidenceIdError);
		expect(() =>
			formatEvidenceId({ streamIndex: 0, ordinal: 0, ptsUs: 1_000_000_000_000, contentDigest: "aaaaaa" }),
		).toThrow(EvidenceIdError);
	});

	it("is a pure function of its inputs (stable across calls)", () => {
		const parts = { streamIndex: 1, ordinal: 10, ptsUs: 333_000, contentDigest: "0f0f0f0f" };
		expect(formatEvidenceId(parts)).toBe(formatEvidenceId(parts));
	});
});

describe("evidence ID lexical sort preserves chronology and provenance", () => {
	it("sorts IDs across the old 6-digit boundary in true PTS order", () => {
		const digest = "abcdef";
		// A monotonic catalog: ordinals and PTS increase together, crossing 999.999s.
		const samples = [
			{ ordinal: 100, ptsUs: 999_000_000 }, // 999.000s
			{ ordinal: 200, ptsUs: 999_999_000 }, // 999.999s
			{ ordinal: 300, ptsUs: 1_000_000_000 }, // 1000.000s (old field overflows here)
			{ ordinal: 400, ptsUs: 3_600_000_000 }, // 3600.000s
		];
		const ids = samples.map((s) => formatEvidenceId({ streamIndex: 0, ...s, contentDigest: digest }));
		const sorted = [...ids].sort();
		expect(sorted).toEqual(ids);
		// Provenance survives the round-trip for every ID.
		for (let i = 0; i < ids.length; i++) {
			const parsed = parseEvidenceId(ids[i]!);
			expect(parsed?.ordinal).toBe(samples[i]!.ordinal);
			expect(parsed?.ptsMs).toBe(Math.round(samples[i]!.ptsUs / 1000));
		}
	});
});

describe("parseEvidenceId", () => {
	it("round-trips the structured fields (pts in ms)", () => {
		const parsed = parseEvidenceId("v0_f000000842_p000057500_2c91a7");
		expect(parsed).toEqual({ streamIndex: 0, ordinal: 842, ptsMs: 57_500, contentDigest: "2c91a7" });
	});

	it("returns undefined for a malformed ID", () => {
		expect(parseEvidenceId("not-an-id")).toBeUndefined();
		expect(parseEvidenceId("v0_f842_p1_2c91a7")).toBeUndefined();
		// The retired 6-digit format is no longer accepted.
		expect(parseEvidenceId("v0_f000842_p057500_2c91a7")).toBeUndefined();
	});
});
