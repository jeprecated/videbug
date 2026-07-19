/**
 * Markdown renderer.
 *
 * A pure function over a validated `AnalysisResultV1`. It performs no I/O, adds no
 * information the JSON does not already carry, and never renders internal artifacts
 * or model reasoning beyond the structured inferences the result already contains.
 * Direct visual observation is rendered separately from explicitly-labeled
 * inference, per the product contract.
 */
import type { AnalysisResultV1, Anomaly, DebugBeat, EvidenceCitation } from "../contracts/analysis-v1.ts";

/** Format integer milliseconds as `mm:ss.mmm`. */
export function formatTimestamp(ms: number): string {
	const clamped = Math.max(0, Math.round(ms));
	const totalSeconds = Math.floor(clamped / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const millis = clamped % 1000;
	const mm = String(minutes).padStart(2, "0");
	const ss = String(seconds).padStart(2, "0");
	const mmm = String(millis).padStart(3, "0");
	return `${mm}:${ss}.${mmm}`;
}

function timeRange(beat: DebugBeat): string {
	const { startMs, endMs, precisionMs } = beat.time;
	if (startMs === endMs) {
		return `${formatTimestamp(startMs)} (point, ±${precisionMs}ms)`;
	}
	return `${formatTimestamp(startMs)}–${formatTimestamp(endMs)} (±${precisionMs}ms)`;
}

function citation(evidence: EvidenceCitation): string {
	return `\`${evidence.frameId}\` @ ${formatTimestamp(evidence.ptsMs)} (${evidence.role})`;
}

function renderBeat(beat: DebugBeat): string[] {
	const lines: string[] = [];
	lines.push(`### ${beat.id} · ${beat.kind} · ${timeRange(beat)}`);
	lines.push("");
	lines.push(`**Observed:** ${beat.observation.summary}`);
	if (beat.transitionFromPrevious) {
		lines.push("");
		lines.push(`**Transition from previous:** ${beat.transitionFromPrevious}`);
	}
	lines.push("");
	lines.push(`- Motion: ${beat.observation.motion}`);
	lines.push(`- Confidence: ${beat.confidence}`);
	if (beat.observation.visibleText.length > 0) {
		lines.push(`- Visible text: ${beat.observation.visibleText.map((t) => `\`${t}\``).join(", ")}`);
	}
	if (beat.evidence.length > 0) {
		lines.push(`- Evidence: ${beat.evidence.map(citation).join("; ")}`);
	}
	if (beat.inferences.length > 0) {
		lines.push("- Inferences (not directly observed):");
		for (const inference of beat.inferences) {
			lines.push(`  - _inference:_ ${inference.statement}`);
		}
	}
	lines.push("");
	return lines;
}

function renderAnomaly(anomaly: Anomaly, index: number): string[] {
	const lines: string[] = [];
	lines.push(`### A${index + 1} · ${anomaly.category} · ${anomaly.severity}`);
	lines.push("");
	lines.push(`**Observed:** ${anomaly.description}`);
	lines.push("");
	lines.push(`**Why suspicious:** ${anomaly.whySuspicious}`);
	lines.push("");
	if (anomaly.beatIds.length > 0) lines.push(`- Beats: ${anomaly.beatIds.join(", ")}`);
	if (anomaly.evidence.length > 0) lines.push(`- Evidence: ${anomaly.evidence.map(citation).join("; ")}`);
	lines.push(`- Confidence: ${anomaly.confidence}`);
	if (anomaly.inference) lines.push(`- _inference:_ ${anomaly.inference}`);
	for (const uncertainty of anomaly.uncertainties) lines.push(`- Uncertainty: ${uncertainty}`);
	lines.push("");
	return lines;
}

function renderList(title: string, items: string[]): string[] {
	if (items.length === 0) return [];
	const lines = [`## ${title}`, ""];
	for (const item of items) lines.push(`- ${item}`);
	lines.push("");
	return lines;
}

export function renderMarkdown(result: AnalysisResultV1): string {
	const lines: string[] = [];

	lines.push("# Debugging handoff");
	lines.push("");
	lines.push(`_Status: **${result.status}** · coverage confidence: ${result.coverage.confidence}_`);
	lines.push("");
	lines.push(
		`Source: \`${result.source.basename}\` · ${formatTimestamp(result.source.durationMs)} · ${result.source.width}×${result.source.height} · ${result.source.averageFps} fps`,
	);
	lines.push("");

	lines.push("## Observed failure");
	lines.push("");
	lines.push(result.summary.observedFailure);
	lines.push("");
	lines.push("## Chronology");
	lines.push("");
	lines.push(result.summary.chronology);
	lines.push("");

	lines.push(
		`_Analyzed ${formatTimestamp(result.coverage.analyzedStartMs)}–${formatTimestamp(result.coverage.analyzedEndMs)}._`,
	);
	if (result.coverage.uninspectedRanges.length > 0) {
		const ranges = result.coverage.uninspectedRanges
			.map((r) => `${formatTimestamp(r.startMs)}–${formatTimestamp(r.endMs)}`)
			.join(", ");
		lines.push("");
		lines.push(`_Uninspected: ${ranges}._`);
	}
	lines.push("");

	lines.push("## Debug beats");
	lines.push("");
	if (result.beats.length === 0) {
		lines.push("_No beats reported._");
		lines.push("");
	} else {
		for (const beat of result.beats) lines.push(...renderBeat(beat));
	}

	lines.push("## Anomalies");
	lines.push("");
	if (result.anomalies.length === 0) {
		lines.push("_No anomalies reported._");
		lines.push("");
	} else {
		result.anomalies.forEach((anomaly, i) => lines.push(...renderAnomaly(anomaly, i)));
	}

	lines.push(...renderList("Reproduction steps", result.handoff.reproductionSteps));
	lines.push(
		...renderList(
			"Suggested investigations",
			result.handoff.suggestedInvestigations.map((s) => `_${s.kind}:_ ${s.statement}`),
		),
	);
	lines.push(...renderList("Uncertainties", result.handoff.uncertainties));

	const p = result.provenance;
	lines.push("---");
	lines.push("");
	lines.push(
		`_Generated by videbug ${p.toolVersion} · analyst: ${p.analystModel}${
			p.reviewerModel ? ` · reviewer: ${p.reviewerModel}` : ""
		} · ffmpeg ${p.ffmpegVersion}._`,
	);
	lines.push(
		`_Inspection: ${p.inspectionCalls} calls, ${p.inspectedCells} cells, ${p.fullResolutionFrames} full-resolution frames._`,
	);
	lines.push("");

	return lines.join("\n");
}
