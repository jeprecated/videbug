/**
 * `--mode fast` end-to-end flow (implementation plan §4, §8, §10; milestone M4).
 *
 * Wires the deterministic evidence engine (M2) and the constrained inspection
 * context (M3) into a real isolated Pi analyst session, runs the analyst protocol,
 * and returns only a validated `AnalysisResultV1`. Fast mode skips the independent
 * reviewer (M5's standard mode) but keeps every deterministic guarantee:
 * registry-backed exact citations, canonical honest complete/partial coverage,
 * runtime-sourced provenance, balanced targetable mandatory windows, and a single
 * bounded repair turn.
 *
 * The private workspace is always cleaned up. Progress is surfaced through
 * `onProgress` for the CLI to route to stderr; the caller emits nothing to stdout
 * except the final validated report.
 */
import { join } from "node:path";
import { runAnalystOrchestration } from "../agent/analyst.ts";
import { createInspectionTools } from "../agent/inspection-tools.ts";
import { type ResolveAnalystModelOptions, resolveAnalystModel } from "../agent/model-resolution.ts";
import { ANALYST_PROMPT_VERSION, analystSystemPrompt, buildAnalystBriefing } from "../agent/prompts.ts";
import { createSubmitAnalysisTool } from "../agent/tools/submit-analysis-tool.ts";
import type { AnalysisResultV1 } from "../contracts/analysis-v1.ts";
import { type InspectionContext, createInspectionContext } from "../evidence/inspection-context.ts";
import { AgentSubmissionError } from "../util/errors.ts";
import {
	type ComposeContext,
	buildInspectionPlan,
	computeTailToleranceMs,
	makeSubmitValidator,
	validateComposed,
	withAgentSession,
} from "./analysis-common.ts";
import { computeAllowancePlan, frozenAllowancePlan, isLongOrBusy } from "./coverage-allowance.ts";
import { type EvidenceEngineResult, runEvidenceEngine } from "./evidence-engine.ts";
import {
	estimateInitialPlan,
	formatAllowanceNotice,
	formatArtifactsKeptProgress,
	formatBusyWarning,
	formatInspectionPlan,
	formatInspectionProgress,
} from "./inspection-progress.ts";
import {
	ensureRequestedArtifactsDirectory,
	sanitizeRequestedArtifactsFailure,
	writeRequestedArtifact,
} from "./requested-path.ts";
import { type RunWorkspace, withRunWorkspace } from "./run-workspace.ts";

export interface FastAnalysisProgressEvent {
	phase: string;
	message: string;
}

export interface FastAnalysisOptions {
	videoPath: string;
	/** `provider/model[:thinking]` reference; a vision-capable model is required. Omit for the Pi default. */
	model?: string;
	maxAgentTurns?: number;
	/** Wall-clock timeout for a single agent turn (ms). */
	turnTimeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (event: FastAnalysisProgressEvent) => void;
	/**
	 * When set, evidence frames/sheets and a run manifest are preserved in this
	 * directory instead of being deleted. Never contains credentials or model
	 * reasoning — only deterministic evidence, budgets, provenance, and counts.
	 */
	keepArtifactsDir?: string;
	/** Test injection: reuse an in-memory auth/registry instead of the user's. */
	modelResolution?: Pick<ResolveAnalystModelOptions, "authStorage" | "modelRegistry">;
}

const DEFAULT_MAX_AGENT_TURNS = 20;

async function runInWorkspace(options: FastAnalysisOptions, workspace: RunWorkspace): Promise<AnalysisResultV1> {
	const emit = (phase: string, message: string) => options.onProgress?.({ phase, message });

	// Resolve the analyst model up front so an unavailable/auth/text-only model
	// fails closed (exit 4) before any expensive work. With no --model this uses
	// the user's Pi default (true one-call), still vision/auth fail-closed.
	const resolved = await resolveAnalystModel({
		...(options.model !== undefined ? { model: options.model } : {}),
		...(options.modelResolution ?? {}),
	});
	const analystModel = `${resolved.model.provider}/${resolved.model.id}`;
	emit("model", `analyst model ${analystModel}${resolved.thinkingLevel ? `:${resolved.thinkingLevel}` : ""}`);

	// Deterministic evidence engine (M2).
	const engineOptions = options.signal
		? { signal: options.signal, onProgress: (e: { phase: string; message: string }) => emit(e.phase, e.message) }
		: { onProgress: (e: { phase: string; message: string }) => emit(e.phase, e.message) };
	const engine = await runEvidenceEngine(options.videoPath, engineOptions);

	// Production AUTO-COVERAGE allowance (see standard-analysis for the rationale).
	// `VTD_FIXED_BUDGETS=1` pins the frozen evaluation budgets for reproducibility.
	const complexity = {
		durationMs: engine.source.durationMs,
		averageFps: engine.source.averageFps,
		frameCount: engine.catalog.frames.length,
		candidateCount: engine.candidates.length,
		isolatedTransientCount: engine.isolatedTransients.length,
	};
	const allowance =
		process.env.VTD_FIXED_BUDGETS === "1"
			? frozenAllowancePlan(engine.source.durationMs)
			: computeAllowancePlan(complexity);
	// Constrained inspection context (M3) bound to the private workspace, with
	// balanced targetable mandatory windows so a busy recording is not collapsed.
	const context = createInspectionContext(engine, {
		videoPath: options.videoPath,
		workspaceDir: join(workspace.dir, "evidence"),
		budgets: allowance.analyst.budgets,
		mandatoryMaxWindowMs: allowance.analyst.mandatoryMaxWindowMs,
		mandatoryMaxGroups: allowance.analyst.mandatoryGroups,
		isolatedMaxWindows: allowance.analyst.isolatedMaxWindows,
		isolatedMaxPeaks: allowance.analyst.isolatedMaxPeaks,
	});
	const initialPlan = estimateInitialPlan(context.mandatoryWindows.length, engine.isolatedTransients.length);
	emit(
		"allowance",
		formatAllowanceNotice({
			role: "analyst",
			auto: allowance.auto,
			rangeInspections: allowance.analyst.budgets.rangeInspections,
			cells: allowance.analyst.budgets.cells,
			fullResolutionFrames: allowance.analyst.budgets.fullResolutionFrames,
			mandatoryWindows: context.mandatoryWindows.length,
			isolatedPeaks: allowance.analyst.isolatedMaxPeaks,
			maxChronologyGaps: allowance.maxChronologyGaps,
			...initialPlan,
		}),
	);
	if (isLongOrBusy(complexity)) {
		emit(
			"warning",
			formatBusyWarning(
				engine.source.durationMs,
				allowance.analyst.estimatedMaxCells,
				allowance.analyst.estimatedMaxImages,
			),
		);
	}

	const compose: ComposeContext = {
		engine,
		context,
		usages: () => [context.budgets.usage()],
		tailToleranceMs: computeTailToleranceMs(engine.source.averageFps),
		meta: { ffmpegVersion: engine.ffmpegVersion, analystModel, promptVersion: ANALYST_PROMPT_VERSION },
	};

	// The five inspection tools plus submit — the ONLY tools the analyst can use.
	// Each inspection surfaces a deterministic, privacy-safe progress line.
	const submit = createSubmitAnalysisTool({ validate: makeSubmitValidator(compose) });
	const customTools = [
		...createInspectionTools(context, { onInspection: (ev) => emit("analyst", formatInspectionProgress(ev)) }),
		submit.tool,
	];

	// Deterministic plan summary before the analyst inspects: what it must cover and
	// its budget (overview is navigation, not coverage).
	emit("plan", formatInspectionPlan(buildInspectionPlan("analyst", context)));

	const sessionParams = {
		model: resolved.model,
		customTools,
		systemPrompt: analystSystemPrompt(),
		workspaceDir: workspace.dir,
		authStorage: resolved.authStorage,
		modelRegistry: resolved.modelRegistry,
		maxTurns: options.maxAgentTurns ?? DEFAULT_MAX_AGENT_TURNS,
		...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
		...(options.signal ? { signal: options.signal } : {}),
		// Bare per-tool start events are superseded by the richer inspection lines above;
		// keep turn (`turn N/max`) and notice signals, which model latency dominates.
		onProgress: (e: { type: string; message: string }) => {
			if (e.type !== "tool") emit("analyst", e.message);
		},
	};

	const payload = await withAgentSession(sessionParams, (runner) =>
		runAnalystOrchestration({
			runner,
			submit,
			briefing: buildAnalystBriefing({
				source: engine.source,
				candidateSummary: context.status().uninspectedCandidates,
				mandatoryWindows: context.mandatoryWindows.map((w) => ({
					startMs: w.startMs,
					endMs: w.endMs,
					candidateCount: w.candidateCount,
					kinds: w.kinds,
					...(w.minDensity !== undefined ? { minDensity: w.minDensity } : {}),
					...(w.peakOrdinals !== undefined ? { peakOrdinals: w.peakOrdinals } : {}),
				})),
				transientWindows: context.transientWindows.map((w) => ({
					startMs: w.startMs,
					endMs: w.endMs,
					candidateCount: w.candidateCount,
					kinds: w.kinds,
				})),
				budgets: {
					rangeInspections: context.budgets.budgets.rangeInspections,
					fullResolutionFrames: context.budgets.budgets.fullResolutionFrames,
					cells: context.budgets.budgets.cells,
				},
			}),
			onProgress: (e) => emit(`analyst:${e.phase}`, e.message),
		}),
	);

	// Compose with the final runtime provenance and re-validate defensively.
	const finalCheck = validateComposed(payload, compose);
	if (!finalCheck.ok) {
		throw new AgentSubmissionError(
			`The captured analysis failed final deterministic validation: ${finalCheck.errors.join("; ")}`,
		);
	}
	emit(
		"validated",
		`analysis validated (${finalCheck.value.beats.length} beat(s), status ${finalCheck.value.status}; ${submit.getAttemptCount()} submit attempt(s), ${submit.getRejectionCount()} rejection(s))`,
	);

	if (options.keepArtifactsDir) {
		await writeRunManifest(options.keepArtifactsDir, finalCheck.value, context, engine, {
			submitAttempts: submit.getAttemptCount(),
			submitRejections: submit.getRejectionCount(),
		});
		emit("artifacts", formatArtifactsKeptProgress());
	}
	return finalCheck.value;
}

/**
 * Write a run manifest alongside the preserved evidence. It records only
 * deterministic provenance, budget usage, mandatory windows, inspected ranges, and
 * submit attempt/rejection COUNTS — never credentials, payloads, or model reasoning.
 */
async function writeRunManifest(
	dir: string,
	result: AnalysisResultV1,
	context: InspectionContext,
	engine: EvidenceEngineResult,
	counts: { submitAttempts: number; submitRejections: number },
): Promise<void> {
	const status = context.status();
	const manifest = {
		manifest: "videbug/fast",
		source: result.source,
		provenance: result.provenance,
		analystPromptVersion: ANALYST_PROMPT_VERSION,
		submitAttempts: counts.submitAttempts,
		submitRejections: counts.submitRejections,
		budgets: status.budgets,
		mandatoryWindows: status.mandatoryWindows,
		inspectedRanges: status.inspectedRanges,
		registeredFrames: status.registeredFrames,
		candidateCount: engine.candidates.length,
	};
	await ensureRequestedArtifactsDirectory(dir);
	await writeRequestedArtifact(join(dir, "run-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function runFastAnalysis(options: FastAnalysisOptions): Promise<AnalysisResultV1> {
	// When keeping artifacts, run in the persistent directory and do NOT clean it.
	// Otherwise use a private workspace that is always removed.
	if (options.keepArtifactsDir) {
		const dir = options.keepArtifactsDir;
		await ensureRequestedArtifactsDirectory(dir);
		const workspace: RunWorkspace = {
			dir,
			path: (...segments: string[]) => join(dir, ...segments),
			cleanup: async () => {},
		};
		try {
			return await runInWorkspace(options, workspace);
		} catch (error) {
			throw sanitizeRequestedArtifactsFailure(error, dir);
		}
	}
	return withRunWorkspace((workspace) => runInWorkspace(options, workspace));
}
