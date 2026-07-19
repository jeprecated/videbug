/**
 * Deterministic contact-sheet renderer (implementation plan §7).
 *
 * Contact sheets are model navigation aids. Their burned-in labels are never
 * authoritative — the ordered text manifest returned alongside the image is. Each
 * cell shows a short, stable cell ID (`C1`, `C2`, …) and an `mm:ss.mmm` timecode,
 * rendered with an explicitly bundled, registered monospace TTF (JetBrains Mono,
 * OFL). System font fallback is never relied upon: if the bundled font cannot be
 * registered the renderer fails closed rather than silently substituting a system
 * face.
 *
 * The renderer:
 *   - preserves each frame's source aspect ratio (letterboxed, never stretched);
 *   - assigns cell IDs in visual order, so the manifest order equals the on-sheet
 *     left-to-right, top-to-bottom order exactly;
 *   - stays within a configured maximum dimension and encoded byte size by
 *     deterministically shrinking the thumbnail scale until both limits hold.
 */
import { fileURLToPath } from "node:url";
import { GlobalFonts, type SKRSContext2D, createCanvas, loadImage } from "@napi-rs/canvas";
import { formatTimecode } from "../util/time.ts";

export class ContactSheetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContactSheetError";
	}
}

export interface ContactSheetCellInput {
	frameId: string;
	ptsMs: number;
	/** Absolute path to the full-resolution source frame PNG. */
	imagePath: string;
	/** Source frame dimensions, used to preserve aspect ratio. */
	width: number;
	height: number;
}

export interface ContactSheetManifestEntry {
	cellId: string;
	frameId: string;
	ptsMs: number;
	timecode: string;
}

export interface ContactSheetResult {
	png: Buffer;
	mimeType: "image/png";
	width: number;
	height: number;
	columns: number;
	rows: number;
	/** Authoritative ordered cell-to-frame manifest; index i == cell C(i+1). */
	manifest: ContactSheetManifestEntry[];
}

export interface ContactSheetOptions {
	/** Base thumbnail width in pixels before any downscaling (default 320). */
	thumbnailWidth?: number;
	/** Label font size in pixels (default 16). */
	fontSize?: number;
	/** Maximum sheet width/height (default 4096). */
	maxDimension?: number;
	/** Maximum encoded PNG size in bytes (default 5 MiB). */
	maxBytes?: number;
}

const FONT_FAMILY = "VTDMono";
const GAP = 6;
const MARGIN = 10;
const LABEL_PAD = 5;
const BACKGROUND = "#101216";
const LABEL_BG = "#000000";
const LABEL_FG = "#ffffff";
const THUMB_BG = "#1c1f26";

let fontRegistered = false;

/**
 * Register the bundled monospace TTF exactly once. `../../assets/fonts/...`
 * resolves identically from `src/evidence/` (dev / vitest) and `dist/evidence/`
 * (built), because both are direct children of the package root. A failed
 * registration is fatal: we never fall back to a system font.
 */
export function ensureBundledFont(): string {
	const fontPath = fileURLToPath(new URL("../../assets/fonts/JetBrainsMono-Regular.ttf", import.meta.url));
	if (fontRegistered) return fontPath;
	const ok = GlobalFonts.registerFromPath(fontPath, FONT_FAMILY);
	if (!ok || !GlobalFonts.has(FONT_FAMILY)) {
		throw new ContactSheetError(`Failed to register the bundled contact-sheet font at ${fontPath}`);
	}
	fontRegistered = true;
	return fontPath;
}

function cellIdFor(index: number): string {
	return `C${index + 1}`;
}

export function buildManifest(cells: readonly ContactSheetCellInput[]): ContactSheetManifestEntry[] {
	return cells.map((cell, index) => ({
		cellId: cellIdFor(index),
		frameId: cell.frameId,
		ptsMs: cell.ptsMs,
		timecode: formatTimecode(cell.ptsMs),
	}));
}

/** Render the manifest as an authoritative, ordered text block for tool output. */
export function formatManifestText(manifest: readonly ContactSheetManifestEntry[]): string {
	const lines = manifest.map((entry) => `${entry.cellId}\t${entry.timecode}\t${entry.frameId}`);
	return ["cell\ttimecode\tframeId", ...lines].join("\n");
}

interface Layout {
	columns: number;
	rows: number;
	contentW: number;
	contentH: number;
	labelH: number;
	sheetW: number;
	sheetH: number;
}

function computeLayout(count: number, srcW: number, srcH: number, thumbW: number, fontSize: number): Layout {
	const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
	const rows = Math.max(1, Math.ceil(count / columns));
	const contentW = Math.max(1, Math.round(thumbW));
	const aspect = srcW > 0 && srcH > 0 ? srcH / srcW : 9 / 16;
	const contentH = Math.max(1, Math.round(contentW * aspect));
	const labelH = fontSize + LABEL_PAD * 2;
	const cellW = contentW;
	const cellH = contentH + labelH;
	const sheetW = MARGIN * 2 + columns * cellW + (columns - 1) * GAP;
	const sheetH = MARGIN * 2 + rows * cellH + (rows - 1) * GAP;
	return { columns, rows, contentW, contentH, labelH, sheetW, sheetH };
}

function drawLetterboxed(
	ctx: SKRSContext2D,
	img: Awaited<ReturnType<typeof loadImage>>,
	x: number,
	y: number,
	boxW: number,
	boxH: number,
): void {
	ctx.fillStyle = THUMB_BG;
	ctx.fillRect(x, y, boxW, boxH);
	const iw = img.width || boxW;
	const ih = img.height || boxH;
	const scale = Math.min(boxW / iw, boxH / ih);
	const drawW = Math.max(1, Math.round(iw * scale));
	const drawH = Math.max(1, Math.round(ih * scale));
	const dx = x + Math.round((boxW - drawW) / 2);
	const dy = y + Math.round((boxH - drawH) / 2);
	ctx.drawImage(img, dx, dy, drawW, drawH);
}

export async function renderContactSheet(
	cells: readonly ContactSheetCellInput[],
	options: ContactSheetOptions = {},
): Promise<ContactSheetResult> {
	if (cells.length === 0) throw new ContactSheetError("Cannot render a contact sheet with zero cells");
	ensureBundledFont();

	const fontSize = options.fontSize ?? 16;
	const maxDimension = options.maxDimension ?? 4096;
	const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
	const first = cells[0]!;
	const manifest = buildManifest(cells);

	// Load each source frame once; reused across any re-render passes.
	const images = await Promise.all(cells.map((cell) => loadImage(cell.imagePath)));

	let thumbW = options.thumbnailWidth ?? 320;
	const minThumbW = 24;

	for (let attempt = 0; attempt < 24; attempt++) {
		const layout = computeLayout(cells.length, first.width, first.height, thumbW, fontSize);

		if ((layout.sheetW > maxDimension || layout.sheetH > maxDimension) && thumbW > minThumbW) {
			const scale = Math.min(maxDimension / layout.sheetW, maxDimension / layout.sheetH);
			thumbW = Math.max(minThumbW, Math.floor(thumbW * scale * 0.98));
			continue;
		}

		const canvas = createCanvas(layout.sheetW, layout.sheetH);
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = BACKGROUND;
		ctx.fillRect(0, 0, layout.sheetW, layout.sheetH);
		ctx.textBaseline = "middle";
		ctx.font = `${fontSize}px '${FONT_FAMILY}'`;

		for (let i = 0; i < cells.length; i++) {
			const col = i % layout.columns;
			const row = Math.floor(i / layout.columns);
			const x = MARGIN + col * (layout.contentW + GAP);
			const y = MARGIN + row * (layout.contentH + layout.labelH + GAP);

			drawLetterboxed(ctx, images[i]!, x, y, layout.contentW, layout.contentH);

			// Label band with the stable cell ID and authoritative-derived timecode.
			const labelY = y + layout.contentH;
			ctx.fillStyle = LABEL_BG;
			ctx.fillRect(x, labelY, layout.contentW, layout.labelH);
			ctx.fillStyle = LABEL_FG;
			ctx.fillText(
				`${manifest[i]!.cellId}  ${manifest[i]!.timecode}`,
				x + LABEL_PAD,
				labelY + layout.labelH / 2,
				layout.contentW - LABEL_PAD * 2,
			);
		}

		const png = canvas.toBuffer("image/png");
		if (png.length > maxBytes && thumbW > minThumbW) {
			thumbW = Math.max(minThumbW, Math.floor(thumbW * 0.8));
			continue;
		}
		if ((layout.sheetW > maxDimension || layout.sheetH > maxDimension) && thumbW <= minThumbW) {
			throw new ContactSheetError(
				`Contact sheet ${layout.sheetW}x${layout.sheetH} exceeds the ${maxDimension}px limit even at the minimum thumbnail size`,
			);
		}
		// Fail closed: the encoded sheet still exceeds the byte budget and there is no
		// smaller thumbnail to fall back to. Never return an over-budget sheet.
		if (png.length > maxBytes) {
			throw new ContactSheetError(
				`Contact sheet encoded to ${png.length} bytes, exceeding the ${maxBytes}-byte limit even at the minimum thumbnail size`,
			);
		}

		return {
			png,
			mimeType: "image/png",
			width: layout.sheetW,
			height: layout.sheetH,
			columns: layout.columns,
			rows: layout.rows,
			manifest,
		};
	}

	throw new ContactSheetError("Failed to fit the contact sheet within the configured dimension/byte budget");
}
