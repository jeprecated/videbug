/**
 * Shared analysis wiring for the fast (analyst-only) and standard
 * (analyst + independent reviewer) flows.
 *
 * Centralises the pieces both modes must implement identically so they cannot
 * drift: runtime-sourced provenance (with combined analyst+reviewer counts and an
 * optional `reviewerModel`), the registry-backed + coverage-honest submit
 * cross-validator, the frame-interval tail tolerance, the balanced mandatory-window
 * width policy, and isolated-session lifecycle. Everything here is deterministic
 * with respect to its inputs; the model is reached only through the injected
 * runner.
 */
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AuthStorage, ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentRunner } from "../agent/agent-runner.ts";
import { createSessionRunner } from "../agent/session-runner.ts";
import { createIsolatedVisionSession } from "../agent/session.ts";
import type { SubmitCrossValidator } from "../agent/tools/submit-analysis-tool.ts";
import type { AnalysisProvenance, AnalysisResultV1, SubmitAnalysisPayload } from "../contracts/analysis-v1.ts";
import { composeAnalysisResult } from "../contracts/analysis-v1.ts";
import {
	type AnalysisValidationResult,
	evidenceRegistryFromEntries,
	validateAnalysisResult,
} from "../contracts/validation.ts";
import type { BudgetUsage } from "../evidence/budgets.ts";
import type { InspectionContext } from "../evidence/inspection-context.ts";
import { readToolVersion } from "../util/version.ts";
import { computeUncoveredSegments, coverageHonestyErrors, prematurePartialErrors } from "./coverage-honesty.ts";
import type { EvidenceEngineResult } from "./evidence-engine.ts";
import type { InspectionPlan } from "./inspection-progress.ts";

/**
 * Derive a DETERMINISTIC plan summary for an agent phase from the reconciled
 * mandatory windows and the session budgets — no model input. Dense windows are
 * those needing a dense pass that are NOT isolated-transient focus windows;
 * isolated windows each additionally require full-resolution peak reads.
 */
export function buildInspectionPlan(role: InspectionPlan["role"], context: InspectionContext): InspectionPlan {
	const windows = context.mandatoryWindows;
	const isPeak = (w: (typeof windows)[number]) => (w.peakOrdinals?.length ?? 0) > 0;
	const denseWindows = windows.filter((w) => w.minDensity !== undefined && !isPeak(w)).length;
	const isolatedWindows = windows.filter(isPeak).length;
	const isolatedPeaks = windows.reduce((n, w) => n + (w.peakOrdinals?.length ?? 0), 0);
	const b = context.budgets.budgets;
	return {
		role,
		mandatoryWindows: windows.length,
		denseWindows,
		isolatedWindows,
		isolatedPeaks,
		rangeInspections: b.rangeInspections,
		cells: b.cells,
		fullResolutionFrames: b.fullResolutionFrames,
	};
}

/**
 * The last decoded source frame's PTS is typically one frame interval before the
 * container duration, so reaching within one frame counts as covering the tail
 * without inventing precision. Derived from the deterministic average fps.
 */
export function computeTailToleranceMs(averageFps: number): number {
	return Math.max(1, Math.ceil(1000 / Math.max(averageFps, 1)));
}

/**
 * Target width for balanced mandatory windows: aim for roughly `rangeInspections`
 * windows across the recording so a busy recording splits into targetable windows
 * instead of collapsing into one whole-video window, with a sane floor.
 */
export function computeMandatoryMaxWindowMs(durationMs: number, rangeInspections: number): number {
	return Math.max(6000, Math.ceil(durationMs / Math.max(1, rangeInspections)));
}

/**
 * Cap the number of mandatory windows BELOW the range-inspection budget so that
 * covering every window once (one inspect_range each, and adjacent windows share a
 * call) still leaves a few calls for boundary/transient refinement. Reserves ~20%
 * of the budget (at least one call), with a floor of one window.
 */
export function computeMandatoryMaxGroups(rangeInspections: number): number {
	const reserve = Math.max(1, Math.floor(rangeInspections * 0.2));
	return Math.max(1, rangeInspections - reserve);
}

/** Frame ID -> exact source PTS entries for a context's live registry. */
export function registryEntries(context: InspectionContext): Array<readonly [string, number]> {
	return context.registry.ids().map((id) => [id, context.registry.get(id)!.ptsMs] as const);
}

export interface ProvenanceMeta {
	ffmpegVersion: string;
	analystModel: string;
	reviewerModel?: string;
	/** Prompt/protocol version tag folded into toolVersion for auditability. */
	promptVersion: string;
}

/**
 * Build runtime-sourced provenance. Counts are SUMMED across every supplied budget
 * usage (analyst plus reviewer), never taken from the model. `reviewerModel` is
 * included only when the standard flow ran a reviewer.
 */
export function buildProvenance(usages: BudgetUsage[], meta: ProvenanceMeta): AnalysisProvenance {
	let inspectionCalls = 0;
	let inspectedCells = 0;
	let fullResolutionFrames = 0;
	for (const usage of usages) {
		inspectionCalls += usage.rangeInspections.used + usage.overviewInspections.used + usage.comparisons.used;
		inspectedCells += usage.cells.used;
		fullResolutionFrames += usage.fullResolutionFrames.used;
	}
	const provenance: AnalysisProvenance = {
		toolVersion: `${readToolVersion()}+${meta.promptVersion}`,
		ffmpegVersion: meta.ffmpegVersion,
		analystModel: meta.analystModel,
		inspectionCalls,
		inspectedCells,
		fullResolutionFrames,
	};
	if (meta.reviewerModel !== undefined) provenance.reviewerModel = meta.reviewerModel;
	return provenance;
}

export interface ComposeContext {
	engine: EvidenceEngineResult;
	/** Live registry view: which frames/coverage exist right now. */
	context: InspectionContext;
	/** Budget usages to SUM into provenance counts (analyst, then reviewer). */
	usages(): BudgetUsage[];
	tailToleranceMs: number;
	meta: ProvenanceMeta;
}

/** Compose the semantic payload with deterministic source + runtime provenance. */
export function composeWith(payload: SubmitAnalysisPayload, cc: ComposeContext): AnalysisResultV1 {
	return composeAnalysisResult(payload, {
		source: cc.engine.source,
		provenance: buildProvenance(cc.usages(), cc.meta),
	});
}

/** Full deterministic validation of a composed result against the live registry. */
export function validateComposed(payload: SubmitAnalysisPayload, cc: ComposeContext): AnalysisValidationResult {
	return validateAnalysisResult(composeWith(payload, cc), {
		registry: evidenceRegistryFromEntries(registryEntries(cc.context)),
		tailToleranceMs: cc.tailToleranceMs,
	});
}

/**
 * The registry-backed + coverage-honest cross-validator injected into
 * `submit_analysis` (and, for a replacement, `submit_review`). It runs the full
 * deterministic validator against the LIVE registry AND the canonical coverage
 * honesty rules (complete/partial). A rejection never latches, so invalid state is
 * never accepted.
 */
export function makeSubmitValidator(cc: ComposeContext): SubmitCrossValidator {
	return (payload: SubmitAnalysisPayload) => {
		const validation = validateComposed(payload, cc);
		const errors = validation.ok ? [] : [...validation.errors];
		const status = cc.context.status();
		const uncovered = computeUncoveredSegments(status);
		errors.push(...coverageHonestyErrors(payload, uncovered));
		// Production auto-coverage: do not accept a premature partial while deterministic
		// coverable segments remain AND spendable inspection allowance is left. A partial
		// stays valid only after the inspection ledger is genuinely exhausted by tool use.
		errors.push(
			...prematurePartialErrors(payload, uncovered, {
				rangeInspections: status.budgets.rangeInspections.remaining,
				cells: status.budgets.cells.remaining,
				fullResolutionFrames: status.budgets.fullResolutionFrames.remaining,
			}),
		);
		return errors.length ? { ok: false, errors } : { ok: true };
	};
}

export interface AgentSessionParams {
	model: Model<Api>;
	customTools: ToolDefinition[];
	systemPrompt: string;
	workspaceDir: string;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	maxTurns?: number;
	turnTimeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (event: { type: string; message: string }) => void;
}

/**
 * Create an isolated, in-memory, vision-only session, wrap it in a session-backed
 * runner (turn budget, wall-clock timeout, abort signal), run `body`, and always
 * dispose the runner (and thus the session) in `finally`.
 */
export async function withAgentSession<T>(
	params: AgentSessionParams,
	body: (runner: AgentRunner) => Promise<T>,
): Promise<T> {
	const handle = await createIsolatedVisionSession({
		model: params.model,
		customTools: params.customTools,
		systemPrompt: params.systemPrompt,
		cwd: params.workspaceDir,
		agentDir: join(params.workspaceDir, "agent"),
		...(params.authStorage ? { authStorage: params.authStorage } : {}),
		...(params.modelRegistry ? { modelRegistry: params.modelRegistry } : {}),
	});

	const runnerOptions: Parameters<typeof createSessionRunner>[1] = {};
	if (params.maxTurns !== undefined) runnerOptions.maxTurns = params.maxTurns;
	if (params.turnTimeoutMs !== undefined) runnerOptions.timeoutMs = params.turnTimeoutMs;
	if (params.signal) runnerOptions.signal = params.signal;
	if (params.onProgress) runnerOptions.onProgress = (e) => params.onProgress?.({ type: e.type, message: e.message });
	const runner = createSessionRunner(handle, runnerOptions);
	try {
		return await body(runner);
	} finally {
		runner.dispose();
	}
}
