/**
 * Deterministic reconciliation of candidate windows with the range-inspection
 * budget (implementation plan §8.4, §11).
 *
 * The deterministic engine can propose far more candidate windows than the
 * per-session range-inspection budget (e.g. 51 candidates against a 12-range
 * budget). If each candidate were separately mandatory, the analyst could never
 * honestly reach `complete` coverage — it would run out of budget and be forced to
 * either mark the overview as coverage (dishonest) or silently ignore candidates.
 *
 * `groupMandatoryWindows` clusters nearby candidate windows into a bounded set of
 * mandatory windows, each coverable by a single targeted `inspect_range` call, so
 * the whole-recording completeness protocol is achievable within budget. Grouping
 * is purely deterministic: same input, same output, independent of insertion
 * order.
 *
 * The result is always ORDERED and strictly NON-OVERLAPPING, and its union covers
 * every candidate, even when candidates overlap each other or a single candidate
 * spans most of a busy recording (that giant candidate stays one window rather
 * than being split into windows that would overlap the candidates nested inside
 * it). This invariant holds regardless of the width/split policy below.
 */

export interface MandatoryWindowInput {
	startMs: number;
	endMs: number;
	kind: string;
}

export interface MandatoryWindow {
	startMs: number;
	endMs: number;
	/** How many candidate windows this mandatory window subsumes. */
	candidateCount: number;
	/** The distinct candidate kinds folded into this window, sorted. */
	kinds: string[];
	/**
	 * When set, this window must be inspected at at least this density (samples per
	 * second) to count as covered — used for narrow transient-focus windows so a
	 * sparse pass over a wide span cannot silently "cover" a sub-second burst.
	 */
	minDensity?: number;
	/**
	 * Peak source frame ordinals (isolated-transient focus only) that must EACH be
	 * read at full resolution (`inspect_frame`) before this window counts as covered —
	 * dense contact-sheet coverage alone does not satisfy an isolated transient.
	 */
	peakOrdinals?: number[];
}

export interface GroupMandatoryOptions {
	/** Upper bound on the number of mandatory windows (typically the range budget). */
	maxGroups: number;
	/** Candidates whose gap is at most this many ms are merged into one window. */
	mergeGapMs: number;
	/**
	 * Maximum targetable window width. A cluster wider than this is split at its
	 * largest internal candidate gap (repeatedly, up to `maxGroups` windows), so a
	 * busy recording is not collapsed into one un-targetable whole-video window.
	 * When omitted, no width-based splitting occurs (backwards compatible).
	 */
	maxWindowMs?: number;
}

interface Member {
	startMs: number;
	endMs: number;
	kind: string;
}

interface Cluster {
	startMs: number;
	endMs: number;
	/** The candidate members, ascending by start, so a cluster can be re-split. */
	members: Member[];
}

function clusterOf(members: Member[]): Cluster {
	return {
		startMs: members[0]!.startMs,
		endMs: Math.max(...members.map((m) => m.endMs)),
		members,
	};
}

function toWindow(cluster: Cluster): MandatoryWindow {
	const kinds = new Set(cluster.members.map((m) => m.kind));
	return {
		startMs: cluster.startMs,
		endMs: cluster.endMs,
		candidateCount: cluster.members.length,
		kinds: [...kinds].sort(),
	};
}

/**
 * Cluster candidate windows into at most `maxGroups` ordered, non-overlapping
 * mandatory windows. Candidates within `mergeGapMs` of the growing cluster are
 * folded in; if that still leaves more than `maxGroups` clusters, the two adjacent
 * clusters separated by the smallest gap are merged repeatedly until the bound is
 * met. Ties are broken toward the earlier gap, so the result is deterministic.
 */
export function groupMandatoryWindows(
	candidates: readonly MandatoryWindowInput[],
	options: GroupMandatoryOptions,
): MandatoryWindow[] {
	if (candidates.length === 0) return [];
	const maxGroups = Math.max(1, Math.floor(options.maxGroups));
	const mergeGapMs = Math.max(0, options.mergeGapMs);

	// Normalize and sort by start (then end) so ordering is input-independent.
	const sorted: Member[] = candidates
		.map((c) => ({
			startMs: Math.min(c.startMs, c.endMs),
			endMs: Math.max(c.startMs, c.endMs),
			kind: c.kind,
		}))
		.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.kind.localeCompare(b.kind));

	let clusters: Cluster[] = [];
	for (const candidate of sorted) {
		const last = clusters[clusters.length - 1];
		if (last && candidate.startMs - last.endMs <= mergeGapMs) {
			last.members.push(candidate);
			last.endMs = Math.max(last.endMs, candidate.endMs);
		} else {
			clusters.push(clusterOf([candidate]));
		}
	}

	// Split over-wide clusters at their largest internal candidate gap so a busy
	// recording yields balanced, targetable windows instead of one whole-video
	// window. Bounded by `maxGroups`, and always cuts the widest cluster's largest
	// internal gap first, so the result is deterministic and compact.
	if (options.maxWindowMs !== undefined && options.maxWindowMs > 0) {
		clusters = splitWideClusters(clusters, options.maxWindowMs, maxGroups);
	}

	// Enforce the cap by merging the closest adjacent clusters until we fit.
	while (clusters.length > maxGroups) {
		let bestIndex = 0;
		let bestGap = Number.POSITIVE_INFINITY;
		for (let i = 0; i < clusters.length - 1; i++) {
			const gap = clusters[i + 1]!.startMs - clusters[i]!.endMs;
			if (gap < bestGap) {
				bestGap = gap;
				bestIndex = i;
			}
		}
		const left = clusters[bestIndex]!;
		const right = clusters[bestIndex + 1]!;
		clusters[bestIndex] = clusterOf([...left.members, ...right.members]);
		clusters.splice(bestIndex + 1, 1);
	}

	return clusters.map(toWindow);
}

/**
 * Cluster narrow transient candidates into a small set of tight, targetable
 * windows. Unlike `groupMandatoryWindows`, this never merges distant clusters to
 * hit a group cap — it merges only ADJACENT transients whose combined width stays
 * within `maxWidthMs`, so each window stays narrow enough to inspect at high
 * density. It then keeps the `maxCount` clusters with the most bursts (ties broken
 * toward the narrowest), re-sorted by start, so the analyst gets the strongest
 * brief-transient regions without an overwhelming list.
 */
export function clusterTransientWindows(
	transients: readonly MandatoryWindowInput[],
	options: { mergeGapMs: number; maxWidthMs: number; maxCount: number },
): MandatoryWindow[] {
	if (transients.length === 0) return [];
	const mergeGapMs = Math.max(0, options.mergeGapMs);
	const maxWidthMs = Math.max(1, options.maxWidthMs);
	const maxCount = Math.max(1, Math.floor(options.maxCount));
	const sorted = transients
		.map((t) => ({ startMs: Math.min(t.startMs, t.endMs), endMs: Math.max(t.startMs, t.endMs) }))
		.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	const clusters: Array<{ startMs: number; endMs: number; count: number }> = [];
	for (const t of sorted) {
		const last = clusters[clusters.length - 1];
		if (last && t.startMs - last.endMs <= mergeGapMs && Math.max(last.endMs, t.endMs) - last.startMs <= maxWidthMs) {
			last.endMs = Math.max(last.endMs, t.endMs);
			last.count += 1;
		} else {
			clusters.push({ startMs: t.startMs, endMs: t.endMs, count: 1 });
		}
	}
	return clusters
		.sort((a, b) => b.count - a.count || a.endMs - a.startMs - (b.endMs - b.startMs))
		.slice(0, maxCount)
		.sort((a, b) => a.startMs - b.startMs)
		.map((c) => ({ startMs: c.startMs, endMs: c.endMs, candidateCount: c.count, kinds: ["transient"] }));
}

/** An isolated-transient candidate with its preserved peak frame, for focus grouping. */
export interface IsolatedTransientInput {
	startMs: number;
	endMs: number;
	peakOrdinal: number;
	/** Peak changed-pixel ratio — the deterministic priority key. */
	peakRatio: number;
}

/**
 * Cluster rare ISOLATED transients into their OWN mandatory focus windows,
 * independent of the normal popularity/score ranking. Adjacent isolated transients
 * within `mergeGapMs` share one narrow, density-gated window that also carries every
 * member's peak ordinal (each requires a full-resolution read). To stay budget-
 * neutral the kept windows are the strongest (by peak ratio) up to `maxWindows`, and
 * the kept peaks up to `maxPeaks`; whatever does not fit is returned as `overflow`
 * so the caller can force an HONEST partial rather than silently marking it inspected.
 */
export function clusterIsolatedFocusWindows(
	isolated: readonly IsolatedTransientInput[],
	options: { mergeGapMs: number; minDensity: number; maxWindows: number; maxPeaks: number },
): { windows: MandatoryWindow[]; overflow: IsolatedTransientInput[] } {
	if (isolated.length === 0) return { windows: [], overflow: [] };
	const mergeGapMs = Math.max(0, options.mergeGapMs);
	const maxWindows = Math.max(0, Math.floor(options.maxWindows));
	const maxPeaks = Math.max(0, Math.floor(options.maxPeaks));

	// Cluster by time (ascending) so adjacent isolated transients share a window.
	const sorted = [...isolated].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	interface Cluster {
		startMs: number;
		endMs: number;
		members: IsolatedTransientInput[];
		maxRatio: number;
	}
	const clusters: Cluster[] = [];
	for (const t of sorted) {
		const last = clusters[clusters.length - 1];
		if (last && t.startMs - last.endMs <= mergeGapMs) {
			last.endMs = Math.max(last.endMs, t.endMs);
			last.members.push(t);
			last.maxRatio = Math.max(last.maxRatio, t.peakRatio);
		} else {
			clusters.push({ startMs: t.startMs, endMs: t.endMs, members: [t], maxRatio: t.peakRatio });
		}
	}

	// Keep the strongest clusters within BOTH the window and peak caps; deterministic.
	const ranked = [...clusters].sort((a, b) => b.maxRatio - a.maxRatio || a.startMs - b.startMs);
	const kept: Cluster[] = [];
	const overflow: IsolatedTransientInput[] = [];
	let peakBudget = maxPeaks;
	for (const cluster of ranked) {
		if (kept.length < maxWindows && cluster.members.length <= peakBudget) {
			kept.push(cluster);
			peakBudget -= cluster.members.length;
		} else {
			overflow.push(...cluster.members);
		}
	}

	const windows: MandatoryWindow[] = kept
		.sort((a, b) => a.startMs - b.startMs)
		.map((c) => ({
			startMs: c.startMs,
			endMs: c.endMs,
			candidateCount: c.members.length,
			kinds: ["isolated-transient"],
			minDensity: options.minDensity,
			peakOrdinals: [...new Set(c.members.map((m) => m.peakOrdinal))].sort((x, y) => x - y),
		}));
	return { windows, overflow: overflow.sort((a, b) => a.startMs - b.startMs) };
}

/**
 * The widest CLEAN internal split point. A cut after member `i` is clean only when
 * the prefix's maximum end does not extend past the next member's start
 * (`prefixMaxEnd <= members[i+1].startMs`); otherwise a member (e.g. a giant
 * candidate spanning most of the recording) straddles the cut and splitting there
 * would produce OVERLAPPING windows. Among clean cuts the widest gap is chosen.
 * Returns `index === -1` when no clean cut exists, so such a cluster stays a single
 * non-overlapping window that still covers all of its members.
 */
function widestCleanCut(cluster: Cluster): { index: number; gap: number } {
	let index = -1;
	let gap = -1;
	let prefixMaxEnd = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < cluster.members.length - 1; i++) {
		prefixMaxEnd = Math.max(prefixMaxEnd, cluster.members[i]!.endMs);
		const nextStart = cluster.members[i + 1]!.startMs;
		if (prefixMaxEnd <= nextStart) {
			const g = nextStart - prefixMaxEnd;
			if (g > gap) {
				gap = g;
				index = i;
			}
		}
	}
	return { index, gap };
}

/**
 * Repeatedly split the widest over-`maxWindowMs` cluster at its widest CLEAN
 * internal candidate gap, until every cluster fits the width bound or the
 * `maxGroups` cap is reached. A cluster with a single member — or one where a
 * member spans across every internal gap (no clean cut) — cannot be split, so a
 * giant candidate stays one window rather than yielding overlapping windows.
 */
function splitWideClusters(clusters: Cluster[], maxWindowMs: number, maxGroups: number): Cluster[] {
	const work = [...clusters];
	while (work.length < maxGroups) {
		// Pick the widest cluster that exceeds the bound and has a clean split point.
		let target = -1;
		let targetWidth = maxWindowMs;
		for (let i = 0; i < work.length; i++) {
			const c = work[i]!;
			const width = c.endMs - c.startMs;
			if (width > targetWidth && c.members.length > 1 && widestCleanCut(c).index >= 0) {
				target = i;
				targetWidth = width;
			}
		}
		if (target === -1) break;
		const cluster = work[target]!;
		const { index } = widestCleanCut(cluster);
		const left = clusterOf(cluster.members.slice(0, index + 1));
		const right = clusterOf(cluster.members.slice(index + 1));
		work.splice(target, 1, left, right);
	}
	// Keep ascending order by start for stable downstream consumption.
	return work.sort((a, b) => a.startMs - b.startMs);
}
