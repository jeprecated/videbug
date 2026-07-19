import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type ContactSheetCellInput,
	buildManifest,
	formatManifestText,
	renderContactSheet,
} from "../../src/evidence/contact-sheet.ts";

let workdir: string;

/** Write a solid-color PNG so cells have real, decodable image content. */
function writeSolidPng(path: string, w: number, h: number, color: string): void {
	const canvas = createCanvas(w, h);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, w, h);
	writeFileSync(path, canvas.toBuffer("image/png"));
}

function makeCells(count: number, w = 160, h = 90): ContactSheetCellInput[] {
	const colors = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#808080", "#ffffff"];
	return Array.from({ length: count }, (_, i) => {
		const path = join(workdir, `frame-${i}.png`);
		writeSolidPng(path, w, h, colors[i % colors.length]!);
		return {
			frameId: `v0_f${String(i).padStart(9, "0")}_p${String(i * 500).padStart(9, "0")}_abcde${i}`,
			ptsMs: i * 500,
			imagePath: path,
			width: w,
			height: h,
		};
	});
}

beforeAll(() => {
	workdir = mkdtempSync(join(tmpdir(), "vtd-sheet-test-"));
});
afterAll(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe("renderContactSheet", () => {
	it("assigns cell IDs in visual order so the manifest order matches the cells", async () => {
		const cells = makeCells(6);
		const sheet = await renderContactSheet(cells);
		expect(sheet.manifest.map((m) => m.cellId)).toEqual(["C1", "C2", "C3", "C4", "C5", "C6"]);
		// Manifest entry i must describe input cell i (same frame ID and timecode).
		sheet.manifest.forEach((entry, i) => {
			expect(entry.frameId).toBe(cells[i]!.frameId);
		});
		expect(sheet.manifest[1]!.timecode).toBe("00:00.500");
	});

	it("preserves source aspect ratio (portrait source yields a taller sheet than landscape)", async () => {
		const wide = await renderContactSheet(makeCells(4, 320, 180), { thumbnailWidth: 200 });
		const tall = await renderContactSheet(makeCells(4, 180, 320), { thumbnailWidth: 200 });
		// Thumbnail width is fixed, so sheet width matches; cell height tracks the
		// source aspect ratio, so the portrait source produces a strictly taller sheet.
		expect(wide.columns).toBe(tall.columns);
		expect(wide.width).toBe(tall.width);
		expect(tall.height).toBeGreaterThan(wide.height);
	});

	it("stays within the configured dimension and byte budgets", async () => {
		const sheet = await renderContactSheet(makeCells(16), { maxDimension: 800, maxBytes: 2_000_000 });
		expect(sheet.width).toBeLessThanOrEqual(800);
		expect(sheet.height).toBeLessThanOrEqual(800);
		expect(sheet.png.length).toBeLessThanOrEqual(2_000_000);
	});

	it("fails closed when the byte budget cannot be met even at the minimum thumbnail size", async () => {
		// An impossibly small byte budget cannot be satisfied by any rendering, so the
		// renderer must throw rather than return an over-budget sheet.
		await expect(renderContactSheet(makeCells(9), { maxBytes: 500 })).rejects.toThrow(
			/byte limit even at the minimum thumbnail size/,
		);
	});

	it("renders a valid decodable PNG of the reported dimensions", async () => {
		const sheet = await renderContactSheet(makeCells(3));
		const decoded = await loadImage(sheet.png);
		expect(decoded.width).toBe(sheet.width);
		expect(decoded.height).toBe(sheet.height);
	});

	// Nix-environment pixel/render assertion: the burned-in labels must actually
	// rasterize glyphs from the bundled font (nonblank), and the manifest order
	// must match the on-sheet cell order. This runs under `devenv test` (npm test).
	it("draws nonblank label glyphs from the bundled font (pixel assertion)", async () => {
		const cells = makeCells(2, 160, 90);
		const sheet = await renderContactSheet(cells, { thumbnailWidth: 200, fontSize: 18 });

		const decoded = await loadImage(sheet.png);
		const probe = createCanvas(sheet.width, sheet.height);
		const ctx = probe.getContext("2d");
		ctx.drawImage(decoded, 0, 0);
		const pixels = ctx.getImageData(0, 0, sheet.width, sheet.height).data;

		// The label band sits directly below each thumbnail. Scan the whole sheet
		// for near-white text pixels; the black label band means any white pixel is
		// a rendered glyph. A blank/failed font render would produce zero.
		let whiteTextPixels = 0;
		for (let i = 0; i < pixels.length; i += 4) {
			if (pixels[i]! > 220 && pixels[i + 1]! > 220 && pixels[i + 2]! > 220) whiteTextPixels++;
		}
		expect(whiteTextPixels).toBeGreaterThan(50);
		expect(sheet.manifest.map((m) => m.cellId)).toEqual(["C1", "C2"]);
	});
});

describe("manifest helpers", () => {
	it("builds an ordered manifest with mm:ss.mmm timecodes", () => {
		const manifest = buildManifest([
			{ frameId: "a", ptsMs: 57_500, imagePath: "/x", width: 1, height: 1 },
			{ frameId: "b", ptsMs: 128_640, imagePath: "/y", width: 1, height: 1 },
		]);
		expect(manifest).toEqual([
			{ cellId: "C1", frameId: "a", ptsMs: 57_500, timecode: "00:57.500" },
			{ cellId: "C2", frameId: "b", ptsMs: 128_640, timecode: "02:08.640" },
		]);
	});

	it("renders an authoritative ordered manifest text block", () => {
		const text = formatManifestText(
			buildManifest([{ frameId: "fid", ptsMs: 1000, imagePath: "/x", width: 1, height: 1 }]),
		);
		expect(text.split("\n")[0]).toBe("cell\ttimecode\tframeId");
		expect(text).toContain("C1\t00:01.000\tfid");
	});
});
