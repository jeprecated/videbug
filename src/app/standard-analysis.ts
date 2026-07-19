/**
 * `--mode standard` end-to-end flow (implementation plan §4, §9; milestone M5).
 *
 * The default one-call product flow: run the deterministic evidence engine, then a
 * constrained isolated Pi ANALYST, deterministically validate its draft, then start
 * a genuinely fresh, independent Pi REVIEWER over that validated draft plus the
 * deterministic source/candidate/mandatory-window summary — with NO analyst
 * transcript or reasoning, its OWN independently auto-sized inspection ledger, and only the
 * constrained evidence tools + `submit_review`. The reviewer may ACCEPT the draft
 * unchanged or submit a COMPLETE REPLACEMENT that passes the same deterministic
 * validator; a reject-without-valid-replacement fails closed (exit 7).
 *
 * The reviewer safely reuses only the deterministic evidence registry/files (so it
 * can cite already-extracted frames) while spending its own independent budget. The
 * final result carries combined runtime-sourced provenance and `reviewerModel`.
 *
 * The private workspace is always cleaned up; only the final validated report is
 * returned for the CLI to render to stdout.
 */
import { join } from "node:path";
import { runAnalystOrchestration } from "../agent/analyst.ts";
import { createInspectionTools } from "../agent/inspection-tools.ts";
import {
	type ResolveAnalystModelOptions,
	assertModelAuthorized,
	resolveAnalystModel,
	resolveModelReference,
} from "../agent/model-resolution.ts";
import {
	ANALYST_PROMPT_VERSION,
	REVIEWER_PROMPT_VERSION,
	analystSystemPrompt,
	buildAnalystBriefing,
	buildReviewerBriefing,
	reviewerSystemPrompt,
} from "../agent/prompts.ts";
import { runReviewerOrchestration } from "../agent/reviewer.ts";
import { createSubmitAnalysisTool } from "../agent/tools/submit-analysis-tool.ts";
import { createSubmitReviewTool } from "../agent/tools/submit-review-tool.ts";
import type { AnalysisResultV1, SubmitAnalysisPayload } from "../contracts/analysis-v1.ts";
import type { SubmitReviewPayload } from "../contracts/review-v1.ts";
import type { BudgetUsage } from "../evidence/budgets.ts";
import {
	type InspectionContext,
	type InspectionStatus,
	createInspectionContext,
} from "../evidence/inspection-context.ts";
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
import { runEvidenceEngine } from "./evidence-engine.ts";
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

export interface StandardAnalysisProgressEvent {
	phase: string;
	message: string;
}

export interface StandardAnalysisOptions {
	videoPath: string;
	/** Analyst `provider/model[:thinking]`. Omit for the user's Pi default (vision required). */
	model?: string;
	/** Reviewer `provider/model[:thinking]`. Omit to reuse the analyst model. */
	reviewModel?: string;
	maxAgentTurns?: number;
	/** Wall-clock timeout for a single agent turn (ms). */
	turnTimeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (event: StandardAnalysisProgressEvent) => void;
	keepArtifactsDir?: string;
	modelResolution?: Pick<ResolveAnalystModelOptions, "authStorage" | "modelRegistry">;
}

const DEFAULT_MAX_AGENT_TURNS = 20;

/**
 * The payload the reviewer's verdict selects: an `accept` keeps the analyst draft
 * unchanged; a `replace` uses the complete replacement. There is no patch/merge.
 */
export function selectReviewedPayload(
	draft: SubmitAnalysisPayload,
	review: SubmitReviewPayload,
): SubmitAnalysisPayload {
	return review.verdict === "replace" ? review.replacement! : draft;
}

async function runInWorkspace(options: StandardAnalysisOptions, workspace: RunWorkspace): Promise<AnalysisResultV1> {
	const emit = (phase: string, message: string) => options.onProgress?.({ phase, message });

	// Resolve BOTH models up front so an unavailable/auth/text-only analyst OR
	// reviewer fails closed (exit 4) before any expensive work. With no --model the
	// analyst uses the user's Pi default; the reviewer defaults to the analyst model.
	const resolved = await resolveAnalystModel({
		...(options.model !== undefined ? { model: options.model } : {}),
		...(options.modelResolution ?? {}),
	});
	const analystModel = `${resolved.model.provider}/${resolved.model.id}`;
	const reviewerResolved = options.reviewModel
		? resolveModelReference(resolved.modelRegistry, options.reviewModel)
		: { model: resolved.model, ...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}) };
	if (options.reviewModel) assertModelAuthorized(resolved.modelRegistry, reviewerResolved.model);
	const reviewerModel = `${reviewerResolved.model.provider}/${reviewerResolved.model.id}`;
	emit("model", `analyst ${analystModel}, reviewer ${reviewerModel}`);

	// Deterministic evidence engine (M2).
	const engineOptions = options.signal
		? { signal: options.signal, onProgress: (e: { phase: string; message: string }) => emit(e.phase, e.message) }
		: { onProgress: (e: { phase: string; message: string }) => emit(e.phase, e.message) };
	const engine = await runEvidenceEngine(options.videoPath, engineOptions);

	// Production AUTO-COVERAGE: derive generous per-video allowances from deterministic
	// complexity so a long/busy recording can complete every mandatory window, every
	// >=5s chronology gap, and its refinement/full-res obligations instead of stopping
	// at the historical evaluation caps. `VTD_FIXED_BUDGETS=1` pins the frozen
	// evaluation budgets for reproducibility. Count ledgers stay as runaway guards.
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
	const tailToleranceMs = computeTailToleranceMs(engine.source.averageFps);
	const summaryFor = (context: InspectionContext) => ({
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
	});

	// ---- Analyst phase -----------------------------------------------------
	const analystContext = createInspectionContext(engine, {
		videoPath: options.videoPath,
		workspaceDir: join(workspace.dir, "evidence"),
		budgets: allowance.analyst.budgets,
		mandatoryMaxWindowMs: allowance.analyst.mandatoryMaxWindowMs,
		mandatoryMaxGroups: allowance.analyst.mandatoryGroups,
		isolatedMaxWindows: allowance.analyst.isolatedMaxWindows,
		isolatedMaxPeaks: allowance.analyst.isolatedMaxPeaks,
	});
	const analystInitialPlan = estimateInitialPlan(
		analystContext.mandatoryWindows.length,
		engine.isolatedTransients.length,
	);
	emit(
		"allowance",
		formatAllowanceNotice({
			role: "analyst",
			auto: allowance.auto,
			rangeInspections: allowance.analyst.budgets.rangeInspections,
			cells: allowance.analyst.budgets.cells,
			fullResolutionFrames: allowance.analyst.budgets.fullResolutionFrames,
			mandatoryWindows: analystContext.mandatoryWindows.length,
			isolatedPeaks: allowance.analyst.isolatedMaxPeaks,
			maxChronologyGaps: allowance.maxChronologyGaps,
			...analystInitialPlan,
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
	const analystCompose: ComposeContext = {
		engine,
		context: analystContext,
		usages: () => [analystContext.budgets.usage()],
		tailToleranceMs,
		meta: { ffmpegVersion: engine.ffmpegVersion, analystModel, promptVersion: ANALYST_PROMPT_VERSION },
	};
	const submit = createSubmitAnalysisTool({ validate: makeSubmitValidator(analystCompose) });

	// Deterministic plan summary before the analyst inspects (overview is navigation,
	// not coverage); each inspection then surfaces a privacy-safe progress line.
	emit("plan", formatInspectionPlan(buildInspectionPlan("analyst", analystContext)));

	const draft = await withAgentSession(
		{
			model: resolved.model,
			customTools: [
				...createInspectionTools(analystContext, {
					onInspection: (ev) => emit("analyst", formatInspectionProgress(ev)),
				}),
				submit.tool,
			],
			systemPrompt: analystSystemPrompt(),
			workspaceDir: workspace.dir,
			authStorage: resolved.authStorage,
			modelRegistry: resolved.modelRegistry,
			maxTurns: options.maxAgentTurns ?? DEFAULT_MAX_AGENT_TURNS,
			...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
			...(options.signal ? { signal: options.signal } : {}),
			// Bare per-tool start events are superseded by the richer inspection lines;
			// keep turn (`turn N/max`) and notice signals.
			onProgress: (e) => {
				if (e.type !== "tool") emit("analyst", e.message);
			},
		},
		(runner) =>
			runAnalystOrchestration({
				runner,
				submit,
				briefing: buildAnalystBriefing({
					...summaryFor(analystContext),
					budgets: {
						rangeInspections: analystContext.budgets.budgets.rangeInspections,
						fullResolutionFrames: analystContext.budgets.budgets.fullResolutionFrames,
						cells: analystContext.budgets.budgets.cells,
					},
				}),
				onProgress: (e) => emit(`analyst:${e.phase}`, e.message),
			}),
	);

	const draftCheck = validateComposed(draft, analystCompose);
	if (!draftCheck.ok) {
		throw new AgentSubmissionError(
			`The captured analysis failed final deterministic validation: ${draftCheck.errors.join("; ")}`,
		);
	}
	// Freeze the analyst's runtime counts AND full ledger/status snapshot so combined
	// provenance is stable and the kept manifest can record the analyst's own budget,
	// inspected ranges, and mandatory windows separately even as the reviewer spends
	// its own independent budget over the shared registry afterwards.
	const analystUsage: BudgetUsage = analystContext.budgets.usage();
	const analystStatusSnapshot: InspectionStatus = analystContext.status();
	emit(
		"analyst-validated",
		`analyst draft validated (${draftCheck.value.beats.length} beat(s), status ${draftCheck.value.status}; ${submit.getAttemptCount()} submit attempt(s), ${submit.getRejectionCount()} rejection(s))`,
	);

	// ---- Reviewer phase (fresh, independent) -------------------------------
	// A separate inspection context: its OWN independently sized ledger, but SHARING the
	// analyst's deterministic evidence registry/files so it can cite already-known
	// frames and extract new ones into the same private workspace.
	const reviewerContext = createInspectionContext(engine, {
		videoPath: options.videoPath,
		workspaceDir: join(workspace.dir, "reviewer-evidence"),
		budgets: allowance.reviewer.budgets,
		registry: analystContext.registry,
		mandatoryMaxWindowMs: allowance.reviewer.mandatoryMaxWindowMs,
		mandatoryMaxGroups: allowance.reviewer.mandatoryGroups,
		isolatedMaxWindows: allowance.reviewer.isolatedMaxWindows,
		isolatedMaxPeaks: allowance.reviewer.isolatedMaxPeaks,
	});
	const reviewerCompose: ComposeContext = {
		engine,
		context: reviewerContext,
		usages: () => [analystUsage, reviewerContext.budgets.usage()],
		tailToleranceMs,
		meta: {
			ffmpegVersion: engine.ffmpegVersion,
			analystModel,
			reviewerModel,
			promptVersion: `${ANALYST_PROMPT_VERSION}+${REVIEWER_PROMPT_VERSION}`,
		},
	};
	const reviewerValidator = makeSubmitValidator(reviewerCompose);
	const submitReview = createSubmitReviewTool({ draft, validate: reviewerValidator });

	// Explicit transition to a genuinely fresh, independent reviewer (no analyst
	// transcript) with its OWN independent ledger (auto-sized to close analyst gaps),
	// then its allowance and plan summary.
	emit("reviewer", "handing the validated analyst draft to a fresh independent reviewer (no analyst transcript)");
	emit(
		"allowance",
		formatAllowanceNotice({
			role: "reviewer",
			auto: allowance.auto,
			rangeInspections: allowance.reviewer.budgets.rangeInspections,
			cells: allowance.reviewer.budgets.cells,
			fullResolutionFrames: allowance.reviewer.budgets.fullResolutionFrames,
			mandatoryWindows: reviewerContext.mandatoryWindows.length,
			isolatedPeaks: allowance.reviewer.isolatedMaxPeaks,
			maxChronologyGaps: allowance.maxChronologyGaps,
			...estimateInitialPlan(reviewerContext.mandatoryWindows.length, engine.isolatedTransients.length),
		}),
	);
	emit("plan", formatInspectionPlan(buildInspectionPlan("reviewer", reviewerContext)));

	const review = await withAgentSession(
		{
			model: reviewerResolved.model,
			customTools: [
				...createInspectionTools(reviewerContext, {
					onInspection: (ev) => emit("reviewer", formatInspectionProgress(ev)),
				}),
				submitReview.tool,
			],
			systemPrompt: reviewerSystemPrompt(),
			workspaceDir: workspace.dir,
			authStorage: resolved.authStorage,
			modelRegistry: resolved.modelRegistry,
			maxTurns: options.maxAgentTurns ?? DEFAULT_MAX_AGENT_TURNS,
			...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
			...(options.signal ? { signal: options.signal } : {}),
			// Bare per-tool start events are superseded by the richer inspection lines;
			// keep turn (`turn N/max`) and notice signals.
			onProgress: (e) => {
				if (e.type !== "tool") emit("reviewer", e.message);
			},
		},
		(runner) =>
			runReviewerOrchestration({
				runner,
				submit: submitReview,
				briefing: buildReviewerBriefing({
					...summaryFor(reviewerContext),
					budgets: {
						rangeInspections: reviewerContext.budgets.budgets.rangeInspections,
						fullResolutionFrames: reviewerContext.budgets.budgets.fullResolutionFrames,
						cells: reviewerContext.budgets.budgets.cells,
					},
					draftJson: JSON.stringify(draftCheck.value, null, 2),
				}),
				onProgress: (e) => emit(`reviewer:${e.phase}`, e.message),
			}),
	);
	emit("reviewer-verdict", `reviewer verdict: ${review.verdict}`);

	// Compose the reviewed result (accept => original semantic draft; replace =>
	// replacement) with combined provenance. Defensively run the COMPLETE reviewer-live
	// validator again after selection: submit_review already checked the same selected
	// payload, but this final gate prevents any future latch/wiring regression from
	// bypassing coverage honesty or the premature-partial guard.
	const finalPayload = selectReviewedPayload(draft, review);
	const finalCross = reviewerValidator(finalPayload);
	if (!finalCross.ok) {
		throw new AgentSubmissionError(
			`The reviewed analysis failed final live coverage validation: ${finalCross.errors.join("; ")}`,
		);
	}
	const finalCheck = validateComposed(finalPayload, reviewerCompose);
	if (!finalCheck.ok) {
		throw new AgentSubmissionError(
			`The reviewed analysis failed final deterministic validation: ${finalCheck.errors.join("; ")}`,
		);
	}
	emit(
		"validated",
		`reviewed analysis validated (${finalCheck.value.beats.length} beat(s), status ${finalCheck.value.status}; verdict ${review.verdict}; review ${submitReview.getAttemptCount()} attempt(s), ${submitReview.getRejectionCount()} rejection(s))`,
	);

	if (options.keepArtifactsDir) {
		const manifest = buildStandardRunManifest({
			source: finalCheck.value.source,
			provenance: finalCheck.value.provenance,
			verdict: review.verdict,
			candidateCount: engine.candidates.length,
			analyst: {
				model: analystModel,
				status: analystStatusSnapshot,
				submitAttempts: submit.getAttemptCount(),
				submitRejections: submit.getRejectionCount(),
			},
			reviewer: {
				model: reviewerModel,
				status: reviewerContext.status(),
				reviewAttempts: submitReview.getAttemptCount(),
				reviewRejections: submitReview.getRejectionCount(),
			},
		});
		await ensureRequestedArtifactsDirectory(options.keepArtifactsDir);
		await writeRequestedArtifact(
			join(options.keepArtifactsDir, "run-manifest.json"),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
		emit("artifacts", formatArtifactsKeptProgress());
	}
	return finalCheck.value;
}

/** One agent's frozen ledger snapshot for the kept run manifest. */
function manifestLedger(status: InspectionStatus): {
	budgets: InspectionStatus["budgets"];
	inspectedRanges: InspectionStatus["inspectedRanges"];
	mandatoryWindows: InspectionStatus["mandatoryWindows"];
	registeredFrames: number;
} {
	return {
		budgets: status.budgets,
		inspectedRanges: status.inspectedRanges,
		mandatoryWindows: status.mandatoryWindows,
		registeredFrames: status.registeredFrames,
	};
}

export interface StandardRunManifestInput {
	source: AnalysisResultV1["source"];
	provenance: AnalysisResultV1["provenance"];
	verdict: "accept" | "replace";
	candidateCount: number;
	analyst: {
		model: string;
		status: InspectionStatus;
		submitAttempts: number;
		submitRejections: number;
	};
	reviewer: {
		model: string;
		status: InspectionStatus;
		reviewAttempts: number;
		reviewRejections: number;
	};
}

/**
 * Deterministic run manifest for a kept standard run. It records the frozen
 * ANALYST and REVIEWER ledgers SEPARATELY (each agent's own budget usage, inspected
 * ranges, mandatory windows, and registered-frame count) alongside the COMBINED
 * runtime provenance, the reviewer verdict, and submit/review attempt + rejection
 * COUNTS. It never records credentials, payloads, verdict rationale, transcripts,
 * or model reasoning. Pure and deterministic, so it is unit-testable.
 */
export function buildStandardRunManifest(input: StandardRunManifestInput) {
	return {
		manifest: "videbug/standard",
		source: input.source,
		provenance: input.provenance,
		analystPromptVersion: ANALYST_PROMPT_VERSION,
		reviewerPromptVersion: REVIEWER_PROMPT_VERSION,
		reviewerVerdict: input.verdict,
		candidateCount: input.candidateCount,
		analyst: {
			model: input.analyst.model,
			submitAttempts: input.analyst.submitAttempts,
			submitRejections: input.analyst.submitRejections,
			...manifestLedger(input.analyst.status),
		},
		reviewer: {
			model: input.reviewer.model,
			reviewAttempts: input.reviewer.reviewAttempts,
			reviewRejections: input.reviewer.reviewRejections,
			...manifestLedger(input.reviewer.status),
		},
	};
}

export async function runStandardAnalysis(options: StandardAnalysisOptions): Promise<AnalysisResultV1> {
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
