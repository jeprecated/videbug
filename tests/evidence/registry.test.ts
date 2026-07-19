import { describe, expect, it } from "vitest";
import type { EvidenceRecord } from "../../src/evidence/extract-evidence.ts";
import { EvidenceRegistry, rangeDensity } from "../../src/evidence/registry.ts";

function record(id: string, ordinal: number, ptsMs: number): EvidenceRecord {
	return {
		id,
		streamIndex: 0,
		ordinal,
		ptsUs: ptsMs * 1000,
		ptsMs,
		contentDigest: "abcdef",
		width: 64,
		height: 64,
		path: `/tmp/${id}.png`,
	};
}

describe("EvidenceRegistry", () => {
	it("registers and resolves records by ID only", () => {
		const reg = new EvidenceRegistry();
		reg.register([record("v0_f000000001_p000000100_abcdef", 1, 100)]);
		expect(reg.has("v0_f000000001_p000000100_abcdef")).toBe(true);
		expect(reg.get("v0_f000000001_p000000100_abcdef")?.ptsMs).toBe(100);
		expect(reg.has("../../etc/passwd")).toBe(false);
		expect(reg.get("unknown")).toBeUndefined();
	});

	it("returns ids in stable chronological (lexical) order", () => {
		const reg = new EvidenceRegistry();
		reg.register([
			record("v0_f000000010_p000001000_aaaaaa", 10, 1000),
			record("v0_f000000002_p000000200_bbbbbb", 2, 200),
		]);
		expect(reg.ids()).toEqual(["v0_f000000002_p000000200_bbbbbb", "v0_f000000010_p000001000_aaaaaa"]);
	});

	it("admits a non-overlapping range", () => {
		const reg = new EvidenceRegistry();
		reg.recordInspectedRange({ startMs: 0, endMs: 1000, reason: "chronology", density: 5, samples: 5 });
		expect(reg.admitRange(2000, 3000, "chronology", 5).ok).toBe(true);
	});

	it("rejects a fully covered same-reason range at equal or lower density", () => {
		const reg = new EvidenceRegistry();
		reg.recordInspectedRange({ startMs: 1000, endMs: 3000, reason: "boundary", density: 10, samples: 20 });
		const rejected = reg.admitRange(1500, 2500, "boundary", 8);
		expect(rejected.ok).toBe(false);
		expect(reg.admitRange(1500, 2500, "boundary", 10).ok).toBe(false);
	});

	it("admits a fully covered range when density increases", () => {
		const reg = new EvidenceRegistry();
		reg.recordInspectedRange({ startMs: 1000, endMs: 3000, reason: "boundary", density: 10, samples: 20 });
		expect(reg.admitRange(1500, 2500, "boundary", 12).ok).toBe(true);
	});

	it("admits a same-reason broad gap closure after a high-density boundary point", () => {
		const reg = new EvidenceRegistry();
		reg.recordInspectedRange({ startMs: 50522, endMs: 50522, reason: "chronology", density: 1000, samples: 1 });
		expect(reg.admitRange(50522, 60309, "chronology", 24 / 9.787)).toEqual({ ok: true });
	});

	it("admits a same-reason request that extends beyond a dense inspected subrange", () => {
		const reg = new EvidenceRegistry();
		reg.recordInspectedRange({ startMs: 52000, endMs: 54000, reason: "chronology", density: 12, samples: 24 });
		expect(reg.admitRange(50522, 60309, "chronology", 24 / 9.787)).toEqual({ ok: true });
	});

	it("treats the union of adjacent same-reason ranges as fully covered", () => {
		const reg = new EvidenceRegistry();
		reg.recordInspectedRange({ startMs: 0, endMs: 1000, reason: "chronology", density: 5, samples: 5 });
		reg.recordInspectedRange({ startMs: 1000, endMs: 2000, reason: "chronology", density: 10, samples: 10 });
		expect(reg.admitRange(250, 1750, "chronology", 8).ok).toBe(false);
		expect(reg.admitRange(250, 1750, "chronology", 11).ok).toBe(true);
	});

	it("admits an overlapping range when the reason differs", () => {
		const reg = new EvidenceRegistry();
		reg.recordInspectedRange({ startMs: 1000, endMs: 2000, reason: "boundary", density: 10, samples: 10 });
		expect(reg.admitRange(1500, 2500, "transient", 1).ok).toBe(true);
	});

	it("tracks cited versus uncited and rejects citing unknown ids", () => {
		const reg = new EvidenceRegistry();
		reg.register([record("v0_f000000001_p000000100_abcdef", 1, 100)]);
		expect(reg.markCited("nope")).toBe(false);
		expect(reg.markCited("v0_f000000001_p000000100_abcdef")).toBe(true);
		expect(reg.citedIds()).toEqual(["v0_f000000001_p000000100_abcdef"]);
		expect(reg.uncitedIds()).toEqual([]);
	});

	it("computes samples-per-second density", () => {
		expect(rangeDensity(0, 1000, 5)).toBeCloseTo(5, 5);
		expect(rangeDensity(1000, 1000, 3)).toBeCloseTo(3000, 5);
	});

	it("indexes records by ordinal (first registration wins)", () => {
		const reg = new EvidenceRegistry();
		reg.register([record("v0_f000000042_p000001000_abcdef", 42, 1000)]);
		reg.register([record("v0_f000000042_p000001000_ffffff", 42, 1000)]);
		expect(reg.getByOrdinal(42)?.id).toBe("v0_f000000042_p000001000_abcdef");
		expect(reg.getByOrdinal(999)).toBeUndefined();
	});

	it("tracks full-resolution reads by ordinal, shared across a reused registry", () => {
		const reg = new EvidenceRegistry();
		reg.register([record("v0_f000000042_p000001000_abcdef", 42, 1000)]);
		expect(reg.hasFullResRead(42)).toBe(false);
		reg.markFullResRead(42);
		expect(reg.hasFullResRead(42)).toBe(true);
		expect(reg.hasFullResRead(7)).toBe(false);
	});
});
