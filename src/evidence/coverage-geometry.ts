/**
 * Frame-interval-tolerant coverage geometry (implementation plan §8.4, §10, §11).
 *
 * Targeted `inspect_range` calls sample explicit SOURCE frames, so the covered
 * span of a single call ends one frame interval before the next call's first
 * sampled frame. Two adjacent ranges that together cover a wide mandatory window
 * therefore leave a sub-frame PTS gap between them. Treating that gap as
 * "uninspected" would dishonestly flag a fully sampled window as incomplete.
 *
 * This module makes coverage tolerant of exactly one frame interval:
 *   - `mergeRangesWithTolerance` folds ranges whose gap is at most the tolerance
 *     into one covered span, so adjacent ranges merge consistently;
 *   - `uncoveredSubsegments` returns the CANONICAL uncovered sub-parts of a span
 *     given the merged coverage, dropping any sliver at or below the tolerance so a
 *     sampled sub-frame sliver is never labelled uninspected;
 *   - `isSpanCovered` is the boolean shorthand (no uncovered subsegments remain).
 *
 * Everything here is pure and deterministic, so it is unit-testable without a
 * model and shared by the inspection status and the coverage-honesty validator.
 */

export interface TimeSpan {
	startMs: number;
	endMs: number;
}

/**
 * Merge ranges into a minimal ascending set of non-overlapping spans, folding any
 * two whose gap is at most `toleranceMs` (one frame interval) into one span. Input
 * order independent.
 */
export function mergeRangesWithTolerance(ranges: ReadonlyArray<TimeSpan>, toleranceMs: number): TimeSpan[] {
	const tol = Math.max(0, toleranceMs);
	const sorted = [...ranges]
		.map((r) => ({ startMs: Math.min(r.startMs, r.endMs), endMs: Math.max(r.startMs, r.endMs) }))
		.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	const merged: TimeSpan[] = [];
	for (const range of sorted) {
		const last = merged[merged.length - 1];
		if (last && range.startMs <= last.endMs + tol) {
			last.endMs = Math.max(last.endMs, range.endMs);
		} else {
			merged.push({ startMs: range.startMs, endMs: range.endMs });
		}
	}
	return merged;
}

/**
 * The canonical uncovered sub-parts of `[startMs, endMs)` given already-merged
 * covered spans. Slivers at or below `toleranceMs` (leading, trailing, or interior
 * against the merge tolerance) are dropped, so a sampled sub-frame sliver is never
 * reported as uninspected. `mergedCovered` must be ascending and non-overlapping
 * (e.g. from `mergeRangesWithTolerance`).
 */
export function uncoveredSubsegments(
	startMs: number,
	endMs: number,
	mergedCovered: ReadonlyArray<TimeSpan>,
	toleranceMs: number,
): TimeSpan[] {
	const tol = Math.max(0, toleranceMs);
	const out: TimeSpan[] = [];
	let cursor = startMs;
	for (const span of mergedCovered) {
		if (span.endMs <= startMs) continue;
		if (span.startMs >= endMs) break;
		const sliceEnd = Math.min(span.startMs, endMs);
		if (sliceEnd - cursor > tol) out.push({ startMs: cursor, endMs: sliceEnd });
		cursor = Math.max(cursor, span.endMs);
		if (cursor >= endMs) break;
	}
	if (endMs - cursor > tol) out.push({ startMs: cursor, endMs });
	return out;
}

/** True when `[startMs, endMs)` has no uncovered subsegments beyond the tolerance. */
export function isSpanCovered(
	startMs: number,
	endMs: number,
	mergedCovered: ReadonlyArray<TimeSpan>,
	toleranceMs: number,
): boolean {
	return uncoveredSubsegments(startMs, endMs, mergedCovered, toleranceMs).length === 0;
}

/**
 * FRAME-AWARE uncovered subsegments of `[startMs, endMs]`.
 *
 * Coverage is ultimately about SOURCE FRAMES, not milliseconds. Screen recordings
 * are heavily variable-frame-rate: a static region can leave multi-second gaps
 * between two CONSECUTIVE source frames. Two inspected ranges whose boundary frames
 * are adjacent in the catalog fully cover the span between them — there is no unseen
 * frame there — even though the ms gap far exceeds one average frame interval.
 *
 * A catalog frame is "seen" when its PTS falls within some inspected range. This
 * returns the spans of consecutive UNSEEN frames within the window; the window is
 * covered when the result is empty.
 */
export function uncoveredFrameSubsegments(
	startMs: number,
	endMs: number,
	framePtsMs: ReadonlyArray<number>,
	covered: ReadonlyArray<TimeSpan>,
	toleranceMs = 0,
): TimeSpan[] {
	const tol = Math.max(0, toleranceMs);
	const out: TimeSpan[] = [];
	let runStart = -1;
	let runEnd = -1;
	// A frame is seen if it falls within an inspected range expanded by one frame
	// interval, so a window's extreme boundary frame counts as covered when the
	// range's own boundary sample lands one frame inside it (sampling imprecision).
	const isSeen = (pts: number): boolean => covered.some((r) => r.startMs - tol <= pts && pts <= r.endMs + tol);
	for (const pts of framePtsMs) {
		if (pts < startMs || pts > endMs) continue;
		if (isSeen(pts)) {
			if (runStart >= 0) {
				out.push({ startMs: runStart, endMs: runEnd });
				runStart = -1;
			}
		} else {
			if (runStart < 0) runStart = pts;
			runEnd = pts;
		}
	}
	if (runStart >= 0) out.push({ startMs: runStart, endMs: runEnd });
	return out;
}

/** True when every source frame in `[startMs, endMs]` falls within an inspected range. */
export function isFrameSpanCovered(
	startMs: number,
	endMs: number,
	framePtsMs: ReadonlyArray<number>,
	covered: ReadonlyArray<TimeSpan>,
	toleranceMs = 0,
): boolean {
	return uncoveredFrameSubsegments(startMs, endMs, framePtsMs, covered, toleranceMs).length === 0;
}
