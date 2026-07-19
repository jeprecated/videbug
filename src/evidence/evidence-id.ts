/**
 * Stable evidence identifiers (implementation plan §6.1).
 *
 * An evidence ID encodes provenance — source stream, frame ordinal, PTS in
 * milliseconds, and a short content digest — in a single stable token, e.g.
 *
 *     v0_f000000842_p000057500_2c91a7
 *
 * The ordinal and PTS-ms fields are FIXED width (9 digits each) so lexical sort
 * of IDs matches chronological/ordinal order. Nine digits hold ordinals up to
 * ~1e9 frames and PTS up to ~277 hours, so recordings far longer than 999.999s
 * (which overflowed the earlier 6-digit fields, corrupting both sort and the
 * parser) round-trip cleanly. A value that would overflow a field fails closed
 * rather than emit an unsortable/unparseable ID.
 *
 * The ID is provenance, NOT a substitute for the timestamp: the canonical PTS
 * always comes from the source frame catalog. The digest binds the ID to the
 * actual extracted pixels so a duplicated or swapped frame produces a different ID.
 */

/** Fixed field widths. Lexical sort == numeric sort only while values fit. */
export const ORDINAL_DIGITS = 9;
export const PTS_MS_DIGITS = 9;

export class EvidenceIdError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvidenceIdError";
	}
}

export interface EvidenceIdParts {
	streamIndex: number;
	ordinal: number;
	/** Source presentation timestamp in integer microseconds. */
	ptsUs: number;
	/** Hex content digest (e.g. sha256 of the frame bytes); truncated to 6 chars. */
	contentDigest: string;
}

export interface ParsedEvidenceId {
	streamIndex: number;
	ordinal: number;
	ptsMs: number;
	contentDigest: string;
}

export const EVIDENCE_ID_PATTERN = new RegExp(
	`^v(\\d+)_f(\\d{${ORDINAL_DIGITS}})_p(\\d{${PTS_MS_DIGITS}})_([0-9a-f]{6})$`,
);

function padField(value: number, width: number, field: string): string {
	if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
		throw new EvidenceIdError(`Evidence ID ${field} must be a non-negative integer, got ${value}.`);
	}
	if (value >= 10 ** width) {
		throw new EvidenceIdError(
			`Evidence ID ${field} ${value} exceeds the ${width}-digit field; refusing to emit an unsortable ID.`,
		);
	}
	return value.toString(10).padStart(width, "0");
}

export function formatEvidenceId(parts: EvidenceIdParts): string {
	const ptsMs = Math.round(parts.ptsUs / 1000);
	const ordinal = padField(parts.ordinal, ORDINAL_DIGITS, "ordinal");
	const pts = padField(ptsMs, PTS_MS_DIGITS, "ptsMs");
	const digest = parts.contentDigest.slice(0, 6);
	return `v${parts.streamIndex}_f${ordinal}_p${pts}_${digest}`;
}

export function parseEvidenceId(id: string): ParsedEvidenceId | undefined {
	const match = EVIDENCE_ID_PATTERN.exec(id);
	if (!match) return undefined;
	return {
		streamIndex: Number.parseInt(match[1]!, 10),
		ordinal: Number.parseInt(match[2]!, 10),
		ptsMs: Number.parseInt(match[3]!, 10),
		contentDigest: match[4]!,
	};
}
