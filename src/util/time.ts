/**
 * Time formatting helpers.
 *
 * Contact-sheet labels and manifests present source PTS as a human-readable
 * `mm:ss.mmm` timecode. The millisecond value is authoritative; the burned-in
 * label is a navigation aid derived deterministically from it.
 */

/**
 * Format an integer millisecond timestamp as `mm:ss.mmm`.
 *
 * Minutes are not wrapped at 60 — a 90-second clip renders `01:30.000` and a
 * two-hour clip renders `120:00.000` — so the label never loses information for
 * long recordings. Negative or non-finite inputs are clamped to zero rather than
 * emitting a misleading label.
 */
export function formatTimecode(ptsMs: number): string {
	const ms = Number.isFinite(ptsMs) && ptsMs > 0 ? Math.round(ptsMs) : 0;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	const millis = ms % 1000;
	const mm = minutes.toString().padStart(2, "0");
	const ss = seconds.toString().padStart(2, "0");
	const mmm = millis.toString().padStart(3, "0");
	return `${mm}:${ss}.${mmm}`;
}
