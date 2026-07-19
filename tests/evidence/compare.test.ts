import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareEvidence } from "../../src/evidence/compare.ts";

let workdir: string;

function writeSolidPng(name: string, color: string, w = 64, h = 64): string {
	const path = join(workdir, name);
	const canvas = createCanvas(w, h);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, w, h);
	writeFileSync(path, canvas.toBuffer("image/png"));
	return path;
}

beforeAll(() => {
	workdir = mkdtempSync(join(tmpdir(), "vtd-compare-test-"));
});
afterAll(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe("compareEvidence", () => {
	it("reports near-zero difference for identical frames", async () => {
		const a = writeSolidPng("a.png", "#204080");
		const b = writeSolidPng("b.png", "#204080");
		const result = await compareEvidence([
			{ id: "idA", imagePath: a },
			{ id: "idB", imagePath: b },
		]);
		expect(result.pairs).toHaveLength(1);
		const pair = result.pairs[0]!;
		expect(pair.fromId).toBe("idA");
		expect(pair.toId).toBe("idB");
		expect(pair.changedPixelRatio).toBeCloseTo(0, 5);
		expect(pair.changedCells).toBe(0);
	});

	it("reports a strong global difference between contrasting frames", async () => {
		const black = writeSolidPng("black.png", "#000000");
		const white = writeSolidPng("white.png", "#ffffff");
		const result = await compareEvidence([
			{ id: "black", imagePath: black },
			{ id: "white", imagePath: white },
		]);
		const pair = result.pairs[0]!;
		expect(pair.changedPixelRatio).toBeCloseTo(1, 2);
		expect(pair.changedCells).toBe(64);
		expect(pair.absDiffMean).toBeGreaterThan(200);
		expect(pair.grid).toHaveLength(64);
	});

	it("produces one comparison per consecutive pair for 3+ frames", async () => {
		const a = writeSolidPng("c1.png", "#000000");
		const b = writeSolidPng("c2.png", "#ffffff");
		const c = writeSolidPng("c3.png", "#000000");
		const result = await compareEvidence([
			{ id: "a", imagePath: a },
			{ id: "b", imagePath: b },
			{ id: "c", imagePath: c },
		]);
		expect(result.pairs.map((p) => [p.fromId, p.toId])).toEqual([
			["a", "b"],
			["b", "c"],
		]);
	});

	it("rejects fewer than two frames", async () => {
		await expect(compareEvidence([{ id: "only", imagePath: "/x" }])).rejects.toThrow(/at least two/);
	});
});
