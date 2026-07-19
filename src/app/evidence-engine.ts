import type { AnalysisSource } from "../contracts/analysis-v1.ts";
import { type CandidateOptions, type CandidateWindow, buildCandidates, rankCandidates } from "../video/candidates.ts";
/**
 * Deterministic evidence engine (implementation plan §6, milestone M2).
 *
 * Runs the trust-boundary phases end-to-end and returns a typed intermediate
 * result. It never calls Pi and never fabricates a final analysis — it produces
 * the deterministic evidence the later analyst/reviewer milestones consume:
 *
 *   1. probe    build the source-PTS frame catalog (fails closed on bad PTS);
 *   2. source   stream the file sha256 and assemble the source fingerprint;
 *   3. scan     stream a low-res grayscale scan, associating 1:1 with the catalog
 *               and computing per-frame signals incrementally (bounded memory);
 *   4. candidates  boundary/stable/local-animation/transient windows;
 *   5. rescan   when the scan degraded to a stride, a full-source-cadence activity
 *               pass recovers sub-stride transients the strided pass would skip.
 *
 * Cancellation is threaded through every ffmpeg call via an `AbortSignal`; the
 * private run workspace (when used by callers) guarantees cleanup on every path.
 */
import { type ChangeSignal, changedPixelRatio, createSignalAccumulator } from "../video/change-signals.ts";
import { type FrameActivity, detectHiddenTransients } from "../video/degraded-rescan.ts";
import { ffmpegVersion } from "../video/ffmpeg.ts";
import { type IsolatedTransient, detectIsolatedTransients } from "../video/isolated-transients.ts";
import { type FrameCatalog, buildFrameCatalog } from "../video/probe.ts";
import { type ScanStreamOptions, type StreamScanResult, scanRecordingStream } from "../video/scan.ts";
import { fingerprintSource } from "../video/source.ts";
import { type CandidateKindCounts, formatCandidateBreakdown } from "./inspection-progress.ts";

/** What the adaptive degraded-policy rescan did (provenance-honest). */
export interface EngineRescanInfo {
	performed: boolean;
	/** Frames examined by the full-source-cadence activity pass. */
	fullCadenceFrames: number;
	/** Sub-stride transient windows recovered that the strided pass had missed. */
	hiddenTransients: number;
}

export interface EvidenceEngineResult {
	source: AnalysisSource;
	catalog: FrameCatalog;
	scan: StreamScanResult;
	signals: ChangeSignal[];
	candidates: CandidateWindow[];
	/**
	 * Rare ISOLATED high-change short transients (a brief distinct screen flashed
	 * between two long-held views, e.g. a leaked debug string on a black screen).
	 * Detected source-relatively; each preserves its peak frame ordinal/PTS.
	 */
	isolatedTransients: IsolatedTransient[];
	rescan: EngineRescanInfo;
	ffmpegVersion: string;
}

export type EnginePhase = "probe" | "source" | "scan" | "signals" | "candidates" | "rescan";

/** Count final candidate windows by kind for the deterministic progress breakdown. */
function countCandidateKinds(candidates: readonly CandidateWindow[]): CandidateKindCounts {
	const counts: CandidateKindCounts = { boundary: 0, stable: 0, localAnimation: 0, transient: 0 };
	for (const c of candidates) {
		if (c.kind === "boundary") counts.boundary++;
		else if (c.kind === "stable") counts.stable++;
		else if (c.kind === "local-animation") counts.localAnimation++;
		else if (c.kind === "transient") counts.transient++;
	}
	return counts;
}

export interface EngineProgressEvent {
	phase: EnginePhase;
	message: string;
}

export interface EvidenceEngineOptions {
	streamIndex?: number;
	scan?: Omit<ScanStreamOptions, "signal" | "forceFullCadence">;
	candidates?: CandidateOptions;
	/** Disable the degraded-policy full-cadence rescan (default: enabled). */
	rescanDegraded?: boolean;
	signal?: AbortSignal;
	onProgress?: (event: EngineProgressEvent) => void;
}

export async function runEvidenceEngine(
	videoPath: string,
	options: EvidenceEngineOptions = {},
): Promise<EvidenceEngineResult> {
	const emit = (phase: EnginePhase, message: string) => options.onProgress?.({ phase, message });

	const catalog = await buildFrameCatalog(
		videoPath,
		options.streamIndex !== undefined ? { streamIndex: options.streamIndex } : undefined,
	);
	emit("probe", `catalog: ${catalog.frames.length} frame(s), stream ${catalog.streamIndex}`);

	const source = await fingerprintSource(videoPath, catalog);
	emit("source", `sha256 ${source.sha256.slice(0, 12)}…, ${source.durationMs}ms, ${source.averageFps.toFixed(2)}fps`);

	// Streaming detail pass: signals are accumulated incrementally so no frame's
	// pixels are retained beyond the previous frame (bounded memory).
	const scanOptions: ScanStreamOptions = { ...options.scan };
	if (options.signal) scanOptions.signal = options.signal;
	const accumulator = createSignalAccumulator();
	const signals: ChangeSignal[] = [];
	const scan = await scanRecordingStream(videoPath, catalog, scanOptions, (frame) => {
		signals.push(accumulator.push(frame));
	});
	const degradedNote = scan.policy.degraded ? ` (degraded stride ${scan.policy.stride})` : "";
	emit("scan", `${scan.policy.mode} scan: ${scan.frameCount} frame(s) at ${scan.width}x${scan.height}${degradedNote}`);
	emit("signals", `${signals.length} change signal(s)`);

	let candidates = buildCandidates(signals, options.candidates ?? {});
	emit("candidates", `${candidates.length} candidate window(s)`);

	// Adaptive rescan: when we degraded to a stride, sweep every source frame at
	// full cadence with a cheap scalar metric to recover sub-stride transients.
	let rescan: EngineRescanInfo = { performed: false, fullCadenceFrames: 0, hiddenTransients: 0 };
	if (scan.policy.degraded && options.rescanDegraded !== false) {
		const sampledOrdinals = signals.map((s) => s.ordinal);
		const stableSampledOrdinals = new Set(
			signals.filter((s) => s.motion === "none" || s.duplicate !== "none").map((s) => s.ordinal),
		);
		const activity: FrameActivity[] = [];
		let prev: Uint8Array | undefined;
		const activityOptions: ScanStreamOptions = { ...options.scan, forceFullCadence: true };
		if (options.signal) activityOptions.signal = options.signal;
		const activityMeta = await scanRecordingStream(videoPath, catalog, activityOptions, (frame) => {
			activity.push({ ordinal: frame.ordinal, ratio: prev ? changedPixelRatio(prev, frame.data) : 0 });
			prev = frame.data;
		});
		const hidden = detectHiddenTransients({ activity, sampledOrdinals, stableSampledOrdinals, catalog });
		if (hidden.length > 0) candidates = rankCandidates([...candidates, ...hidden]);
		rescan = { performed: true, fullCadenceFrames: activityMeta.frameCount, hiddenTransients: hidden.length };
		emit("rescan", `full-cadence rescan: ${activityMeta.frameCount} frame(s), ${hidden.length} hidden transient(s)`);
	}

	const version = await ffmpegVersion(options.signal ? { signal: options.signal } : undefined);

	// Rare isolated high-change short transients (brief flashed states). Source-
	// relative; surfaced separately so a downstream layer can force a full-resolution
	// read of each peak frame that a sparse contact sheet would step over.
	const isolatedTransients = detectIsolatedTransients(signals);
	// Deterministic human breakdown of the FINAL candidate set by kind (plus the
	// isolated-transient count) so progress shows what the scan found, not just a total.
	emit("candidates", formatCandidateBreakdown(countCandidateKinds(candidates), isolatedTransients.length));

	return { source, catalog, scan, signals, candidates, isolatedTransients, rescan, ffmpegVersion: version };
}

export interface EngineDiagnostic {
	diagnostic: "evidence-engine";
	source: AnalysisSource;
	ffmpegVersion: string;
	scan: {
		mode: StreamScanResult["policy"]["mode"];
		degraded: boolean;
		stride: number;
		width: number;
		height: number;
		frameCount: number;
	};
	rescan: EngineRescanInfo;
	signals: {
		count: number;
		exactDuplicates: number;
		nearDuplicates: number;
		globalMotion: number;
		localMotion: number;
	};
	isolatedTransients: Array<{
		startOrdinal: number;
		endOrdinal: number;
		startMs: number;
		endMs: number;
		peakOrdinal: number;
		peakMs: number;
		peakRatio: number;
	}>;
	candidates: {
		total: number;
		byKind: Record<string, number>;
		windows: Array<{
			kind: string;
			startOrdinal: number;
			endOrdinal: number;
			startMs: number;
			endMs: number;
			representativeOrdinal: number;
			score: number;
		}>;
	};
}

/**
 * A deterministic, JSON-serialisable summary of an engine run. This is diagnostic
 * output for the `--dry-run` mechanism and for the reference-video report; it is
 * explicitly NOT an `AnalysisResultV1` and never claims a completed analysis.
 */
export function summarizeEngineResult(result: EvidenceEngineResult): EngineDiagnostic {
	const byKind: Record<string, number> = {};
	for (const candidate of result.candidates) {
		byKind[candidate.kind] = (byKind[candidate.kind] ?? 0) + 1;
	}
	return {
		diagnostic: "evidence-engine",
		source: result.source,
		ffmpegVersion: result.ffmpegVersion,
		scan: {
			mode: result.scan.policy.mode,
			degraded: result.scan.policy.degraded,
			stride: result.scan.policy.stride,
			width: result.scan.width,
			height: result.scan.height,
			frameCount: result.scan.frameCount,
		},
		rescan: result.rescan,
		signals: {
			count: result.signals.length,
			exactDuplicates: result.signals.filter((s) => s.duplicate === "exact").length,
			nearDuplicates: result.signals.filter((s) => s.duplicate === "near").length,
			globalMotion: result.signals.filter((s) => s.motion === "global").length,
			localMotion: result.signals.filter((s) => s.motion === "local").length,
		},
		isolatedTransients: result.isolatedTransients.map((t) => ({
			startOrdinal: t.startOrdinal,
			endOrdinal: t.endOrdinal,
			startMs: Math.round(t.startPtsUs / 1000),
			endMs: Math.round(t.endPtsUs / 1000),
			peakOrdinal: t.peakOrdinal,
			peakMs: Math.round(t.peakPtsUs / 1000),
			peakRatio: t.peakRatio,
		})),
		candidates: {
			total: result.candidates.length,
			byKind,
			windows: result.candidates.map((c) => ({
				kind: c.kind,
				startOrdinal: c.startOrdinal,
				endOrdinal: c.endOrdinal,
				startMs: Math.round(c.startPtsUs / 1000),
				endMs: Math.round(c.endPtsUs / 1000),
				representativeOrdinal: c.representativeOrdinal,
				score: c.score,
			})),
		},
	};
}
