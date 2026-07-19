/**
 * Deterministic candidate-window proposals over the change-signal series.
 *
 * These windows are proposals, never assertions (implementation plan §6.2). They
 * tell the later vision agent where to look: hard transitions (boundary), long
 * quiet spans (stable), sustained localized motion (local-animation), and short
 * high-change bursts surrounded by stability (transient). Merging and ranking are
 * deterministic so the same signals always yield the same, stably ordered set.
 */
import type { ChangeSignal } from "./change-signals.ts";

export type CandidateKind = "boundary" | "stable" | "local-animation" | "transient";

export interface CandidateWindow {
	kind: CandidateKind;
	startOrdinal: number;
	endOrdinal: number;
	startPtsUs: number;
	endPtsUs: number;
	/** Higher = more worth inspecting. Ranking key (see `rank`). */
	score: number;
	/** A representative frame ordinal inside the window. */
	representativeOrdinal: number;
}

export interface CandidateOptions {
	/** Minimum consecutive low-change frames to propose a stable window. */
	minStableRun?: number;
	/** Minimum consecutive local-motion frames to propose a local-animation window. */
	minLocalRun?: number;
	/** A boundary window no longer than this many frames may also be a transient. */
	maxTransientFrames?: number;
}

const DEFAULTS = {
	minStableRun: 8,
	minLocalRun: 6,
	maxTransientFrames: 3,
} as const;

interface Run {
	start: number; // index into signals
	end: number; // inclusive index into signals
}

function ptsAt(signals: ChangeSignal[], index: number): number {
	return signals[index]!.ptsUs;
}

/** Contiguous index runs where `predicate` holds. */
function runsWhere(signals: ChangeSignal[], predicate: (s: ChangeSignal) => boolean): Run[] {
	const runs: Run[] = [];
	let start = -1;
	for (let i = 0; i < signals.length; i++) {
		if (predicate(signals[i]!)) {
			if (start === -1) start = i;
		} else if (start !== -1) {
			runs.push({ start, end: i - 1 });
			start = -1;
		}
	}
	if (start !== -1) runs.push({ start, end: signals.length - 1 });
	return runs;
}

function windowFromRun(
	signals: ChangeSignal[],
	run: Run,
	kind: CandidateKind,
	score: number,
	representativeIndex: number,
): CandidateWindow {
	return {
		kind,
		startOrdinal: signals[run.start]!.ordinal,
		endOrdinal: signals[run.end]!.ordinal,
		startPtsUs: ptsAt(signals, run.start),
		endPtsUs: ptsAt(signals, run.end),
		score,
		representativeOrdinal: signals[representativeIndex]!.ordinal,
	};
}

function isLowChange(s: ChangeSignal): boolean {
	return s.motion === "none" || s.duplicate === "exact" || s.duplicate === "near";
}

/** Deterministic ordering: score desc, then startOrdinal asc, then kind asc. */
function rank(a: CandidateWindow, b: CandidateWindow): number {
	if (b.score !== a.score) return b.score - a.score;
	if (a.startOrdinal !== b.startOrdinal) return a.startOrdinal - b.startOrdinal;
	return a.kind.localeCompare(b.kind);
}

/** Sort candidate windows by the canonical deterministic rank (a fresh array). */
export function rankCandidates(windows: CandidateWindow[]): CandidateWindow[] {
	return [...windows].sort(rank);
}

export function buildCandidates(signals: ChangeSignal[], options: CandidateOptions = {}): CandidateWindow[] {
	const opts = { ...DEFAULTS, ...options };
	if (signals.length < 2) return [];

	const windows: CandidateWindow[] = [];

	const peakOf = (run: Run): { index: number; ratio: number } => {
		let index = run.start;
		let ratio = signals[run.start]!.changedPixelRatio;
		for (let i = run.start; i <= run.end; i++) {
			if (signals[i]!.changedPixelRatio > ratio) {
				ratio = signals[i]!.changedPixelRatio;
				index = i;
			}
		}
		return { index, ratio };
	};

	// Boundary windows: merged runs of consecutive global-motion frames.
	for (const run of runsWhere(signals, (s) => s.motion === "global")) {
		const peak = peakOf(run);
		windows.push(windowFromRun(signals, run, "boundary", 1000 + peak.ratio * 100, peak.index));
	}

	// Transient windows: any brief ACTIVE burst (global OR localized) bounded by
	// low-change frames on both sides. Localized flashes (e.g. a momentary error
	// toast) are local motion, not a global cut, so a global-only rule would miss
	// them; this catches both while excluding sustained animation (too long).
	for (const run of runsWhere(signals, (s) => s.motion !== "none")) {
		const runLength = run.end - run.start + 1;
		if (runLength > opts.maxTransientFrames) continue;
		const before = signals[run.start - 1];
		const after = signals[run.end + 1];
		if (!before || !after || !isLowChange(before) || !isLowChange(after)) continue;
		const peak = peakOf(run);
		windows.push({
			kind: "transient",
			startOrdinal: before.ordinal,
			endOrdinal: after.ordinal,
			startPtsUs: before.ptsUs,
			endPtsUs: after.ptsUs,
			score: 900 + peak.ratio * 100,
			representativeOrdinal: signals[peak.index]!.ordinal,
		});
	}

	// Stable windows: long low-change runs.
	for (const run of runsWhere(signals, isLowChange)) {
		const length = run.end - run.start + 1;
		if (length < opts.minStableRun) continue;
		const mid = Math.floor((run.start + run.end) / 2);
		windows.push(windowFromRun(signals, run, "stable", length, mid));
	}

	// Local-animation windows: sustained localized motion without a global cut.
	for (const run of runsWhere(signals, (s) => s.motion === "local")) {
		const length = run.end - run.start + 1;
		if (length < opts.minLocalRun) continue;
		const mid = Math.floor((run.start + run.end) / 2);
		windows.push(windowFromRun(signals, run, "local-animation", length, mid));
	}

	return rankCandidates(windows);
}
