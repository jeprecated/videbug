/**
 * CLI-compatible analyst model resolution (implementation plan §4, §8.1).
 *
 * Reuses the user's normal Pi configuration through `AuthStorage`, `ModelRegistry`,
 * `SettingsManager`, `resolveCliModel`, and `resolveModelScopeWithDiagnostics`, so
 * behaviour matches the Pi CLI:
 *
 *   - `--model provider/model[:thinking]` is the highest-priority override and
 *     resolves exactly as it does elsewhere in Pi.
 *   - with NO `--model`, selection mirrors Pi's enabled/default model semantics:
 *     the user's `enabledModels` patterns are resolved to a scope, and the saved
 *     default is used when it is an authenticated member of that scope, otherwise
 *     the first scoped model is used. When no enabled scope is usable, an exact
 *     authenticated saved default is used; a stale/missing/unauthorised default
 *     falls back to the first authenticated vision-capable model (it is NOT an
 *     error to have a stale default when Pi itself would fall back).
 *
 * Two fail-closed gates apply to the finally-selected model before a session is
 * built, regardless of how it was chosen:
 *
 *   1. the model must accept images — a text-only model cannot see contact sheets
 *      or full-resolution frames, so it is rejected (exit 4) with no arbitrary
 *      substitution; and
 *   2. the model must have configured auth (`assertModelAuthorized`) so the run
 *      does not start only to fail on the first provider call.
 *
 * Both gates raise `PiUnavailableError` (exit code 4) to match the documented
 * contract.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	ModelRegistry,
	SettingsManager,
	resolveCliModel,
	resolveModelScopeWithDiagnostics,
} from "@earendil-works/pi-coding-agent";
import { PiUnavailableError } from "../util/errors.ts";
import { VisionModelError, assertVisionCapable } from "./vision-capability.ts";

// ThinkingLevel lives in the nested @earendil-works/pi-agent-core, which is not a
// direct dependency; derive it from resolveCliModel's return type instead.
type ThinkingLevel = NonNullable<ReturnType<typeof resolveCliModel>["thinkingLevel"]>;

export interface ResolvedModelReference {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

export interface ResolvedAnalystModel extends ResolvedModelReference {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}

/** Minimal structural view of the auth check we need from a ModelRegistry. */
interface AuthCheckable {
	hasConfiguredAuth(model: Model<Api>): boolean;
}

/**
 * Minimal structural view of the registry needed for no-`--model` default
 * resolution: available (auth-configured) models, a by-reference lookup, and the
 * auth check. The real `ModelRegistry` satisfies this; tests inject deterministic
 * fakes.
 */
export interface DefaultResolutionRegistry {
	getAvailable(): Model<Api>[];
	find(provider: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(model: Model<Api>): boolean;
}

/** A model in the resolved enabled scope, with an optional pattern thinking level. */
export interface ScopedSelection {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

/**
 * Resolves `enabledModels` patterns (globs, `provider/model`, `:thinking` suffix)
 * to concrete authenticated models, matching Pi's `--models`/`enabledModels`
 * semantics. Defaults to the SDK resolver; injectable for deterministic tests.
 */
export type ScopeResolver = (
	patterns: string[],
	modelRegistry: DefaultResolutionRegistry,
) => Promise<ScopedSelection[]>;

/** Minimal structural view of the merged Pi settings we read for default selection. */
export interface ModelSettingsView {
	getDefaultProvider(): string | undefined;
	getDefaultModel(): string | undefined;
	getDefaultThinkingLevel(): ThinkingLevel | undefined;
	getEnabledModels(): string[] | undefined;
}

const defaultScopeResolver: ScopeResolver = async (patterns, modelRegistry) => {
	const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, modelRegistry as unknown as ModelRegistry);
	return scopedModels as ScopedSelection[];
};

/** Read the merged Pi settings default/enabled selection, tolerating any error. */
function readModelSettings(settings: ModelSettingsView | null | undefined): {
	provider: string | undefined;
	model: string | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	enabled: string[];
} {
	const safe = <T>(fn: () => T): T | undefined => {
		try {
			return fn();
		} catch {
			return undefined;
		}
	};
	if (!settings) return { provider: undefined, model: undefined, thinkingLevel: undefined, enabled: [] };
	return {
		provider: safe(() => settings.getDefaultProvider()),
		model: safe(() => settings.getDefaultModel()),
		thinkingLevel: safe(() => settings.getDefaultThinkingLevel()),
		enabled: safe(() => settings.getEnabledModels()) ?? [],
	};
}

/** Load the merged on-disk Pi settings view, tolerating any error. */
function loadModelSettings(): ModelSettingsView | undefined {
	try {
		return SettingsManager.create(process.cwd()) as unknown as ModelSettingsView;
	} catch {
		return undefined;
	}
}

/**
 * Apply the vision fail-closed gate to a selected model and attach the thinking
 * level. A text-only model is rejected (exit 4) with no arbitrary substitution.
 */
function finalizeVisionSelection(model: Model<Api>, thinkingLevel: ThinkingLevel | undefined): ResolvedModelReference {
	try {
		assertVisionCapable(model);
	} catch (error) {
		if (error instanceof VisionModelError) throw new PiUnavailableError(error.message, error);
		throw error;
	}
	return thinkingLevel !== undefined ? { model, thinkingLevel } : { model };
}

/**
 * Resolve the model to use when no `--model` is supplied, mirroring Pi's
 * enabled/default model selection while keeping this app's vision fail-closed gate.
 *
 * Order:
 *   1. If `enabledModels` resolves to a non-empty scope, use the saved default when
 *      it is an authenticated member of that scope, otherwise the first scoped
 *      model (Pi new-session semantics). Explicit pattern thinking wins, else the
 *      settings default thinking applies.
 *   2. Otherwise, if there is an exact authenticated saved default, use it.
 *   3. Otherwise fall back to the first authenticated vision-capable available
 *      model (Pi-style fallback rather than erroring on a stale default name).
 *
 * The finally-selected model must accept images or the run fails closed (exit 4);
 * a valid selected text-only model is never silently swapped for another.
 */
export async function resolveDefaultModel(
	modelRegistry: DefaultResolutionRegistry,
	settings: ModelSettingsView | null | undefined,
	resolveScope: ScopeResolver = defaultScopeResolver,
): Promise<ResolvedModelReference> {
	const { provider, model, thinkingLevel: defaultThinking, enabled } = readModelSettings(settings);

	// 1. Enabled scope (Pi `enabledModels` semantics).
	const scoped = enabled.length > 0 ? await resolveScope(enabled, modelRegistry) : [];
	if (scoped.length > 0) {
		let preferred: ScopedSelection | undefined;
		if (provider && model) {
			const saved = modelRegistry.find(provider, model);
			if (saved && modelRegistry.hasConfiguredAuth(saved)) {
				preferred = scoped.find((s) => s.model.provider === saved.provider && s.model.id === saved.id);
			}
		}
		// The saved default if it is an authenticated scope member, else the first
		// scoped model (Pi new-session selection). `scoped` is non-empty here.
		const selection = preferred ?? scoped[0];
		if (selection) return finalizeVisionSelection(selection.model, selection.thinkingLevel ?? defaultThinking);
	}

	// 2. No usable enabled scope: an exact authenticated saved default.
	if (provider && model) {
		const saved = modelRegistry.find(provider, model);
		if (saved && modelRegistry.hasConfiguredAuth(saved)) {
			return finalizeVisionSelection(saved, defaultThinking);
		}
	}

	// 3. Pi-style fallback: first authenticated vision-capable available model.
	const available = modelRegistry.getAvailable();
	if (available.length === 0) {
		throw new PiUnavailableError(
			"No Pi model with configured auth is available. Run `pi login`, or pass --model provider/model to select one.",
		);
	}
	const vision = available.find((m) => m.input.includes("image"));
	if (!vision) {
		throw new PiUnavailableError(
			"Your available Pi models cannot accept images; a vision-capable model is required. Pass --model provider/model.",
		);
	}
	return defaultThinking !== undefined ? { model: vision, thinkingLevel: defaultThinking } : { model: vision };
}

/**
 * Resolve a `provider/model[:thinking]` reference to a vision-capable model using
 * the same rules as the rest of the Pi CLI. Throws `PiUnavailableError` (exit 4)
 * on an unresolvable reference or a text-only model.
 */
export function resolveModelReference(modelRegistry: ModelRegistry, reference: string): ResolvedModelReference {
	const result = resolveCliModel({ cliModel: reference, modelRegistry });
	if (result.error) throw new PiUnavailableError(result.error);
	if (!result.model) {
		throw new PiUnavailableError(
			`Could not resolve model ${JSON.stringify(reference)}. Use a provider/model reference from your Pi configuration.`,
		);
	}
	try {
		assertVisionCapable(result.model);
	} catch (error) {
		if (error instanceof VisionModelError) throw new PiUnavailableError(error.message, error);
		throw error;
	}
	const resolved: ResolvedModelReference = { model: result.model };
	if (result.thinkingLevel !== undefined) resolved.thinkingLevel = result.thinkingLevel;
	return resolved;
}

/** Fail closed (exit 4) if the model has no configured auth in the registry. */
export function assertModelAuthorized(modelRegistry: AuthCheckable, model: Model<Api>): void {
	if (!modelRegistry.hasConfiguredAuth(model)) {
		const label = `${model.provider}/${model.id}`;
		throw new PiUnavailableError(
			`No configured Pi auth for ${label}. Add credentials for this provider (e.g. via \`pi login\`) or choose a different --model.`,
		);
	}
}

export interface ResolveAnalystModelOptions {
	/** `provider/model[:thinking]` reference. The highest-priority override. */
	model?: string;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	/**
	 * Injected merged-settings view for the no-`--model` path. `undefined` reads the
	 * on-disk Pi settings; an explicit object or `null` (no readable settings) skips
	 * the disk read — used by tests to stay offline.
	 */
	settings?: ModelSettingsView | null;
	/** Injected enabled-scope resolver (defaults to the SDK resolver). */
	resolveScope?: ScopeResolver;
}

/**
 * Full analyst-model resolution: construct (or reuse) the user's auth/registry,
 * resolve the reference (explicit `--model`) or the Pi enabled/default selection,
 * and enforce the vision and auth gates. Returns the model plus the registry/auth
 * so the caller can build an isolated session that shares the same credentials.
 */
export async function resolveAnalystModel(options: ResolveAnalystModelOptions): Promise<ResolvedAnalystModel> {
	const authStorage = options.authStorage ?? AuthStorage.create();
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage);

	// Explicit --model is the highest priority. With no --model, mirror Pi's
	// enabled/default model selection (settings default + enabledModels), keeping
	// the vision + auth fail-closed gates on the finally-selected model.
	const resolved = options.model
		? resolveModelReference(modelRegistry, options.model)
		: await resolveDefaultModel(
				modelRegistry,
				options.settings === undefined ? (loadModelSettings() ?? null) : options.settings,
				options.resolveScope ?? defaultScopeResolver,
			);
	assertModelAuthorized(modelRegistry, resolved.model);

	return { ...resolved, authStorage, modelRegistry };
}
