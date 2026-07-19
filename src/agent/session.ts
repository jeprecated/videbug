import type { Api, Model } from "@earendil-works/pi-ai";
/**
 * Isolated, in-memory, vision-only Pi session factory (M0 spike foundation).
 *
 * Establishes the analyst/reviewer session isolation contract:
 *   - no built-in coding tools (`noTools: "all"`), only the allowlisted custom
 *     video tools;
 *   - in-memory session and settings (no persistence, compaction disabled);
 *   - a custom system-prompt override plus `appendSystemPromptOverride: () => []`
 *     so unrelated user/project append prompts cannot enter the analysis session;
 *   - a fail-closed vision-capability check before the session is built.
 *
 * The factory never issues a prompt; sending evidence to a provider is the
 * caller's responsibility. Callers must call `dispose()` in a `finally` block.
 */
import {
	AuthStorage,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { assertVisionCapable } from "./vision-capability.ts";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

export interface IsolatedVisionSessionOptions {
	/** A resolved, vision-capable model. */
	model: Model<Api>;
	/** The exact allowlist of custom tools to expose. No other tools are enabled. */
	customTools: ToolDefinition[];
	/** System prompt override for the isolated session. */
	systemPrompt: string;
	cwd: string;
	agentDir: string;
	/** Optional injected auth/model registry (tests use in-memory instances). */
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
}

export interface IsolatedVisionSessionHandle {
	session: Session;
	dispose(): void;
}

export async function createIsolatedVisionSession(
	options: IsolatedVisionSessionOptions,
): Promise<IsolatedVisionSessionHandle> {
	// Fail closed before building anything if the model cannot see images.
	assertVisionCapable(options.model);

	const authStorage = options.authStorage ?? AuthStorage.create();
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage);

	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		systemPromptOverride: () => options.systemPrompt,
		appendSystemPromptOverride: () => [],
	});
	await resourceLoader.reload();

	const { session, extensionsResult } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		model: options.model,
		noTools: "all",
		tools: options.customTools.map((t) => t.name),
		customTools: options.customTools,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		authStorage,
		modelRegistry,
	});

	// Validate extension/resource diagnostics before any prompt is sent. The
	// isolated session discovers no project extensions, so any load error is a
	// configuration fault we must surface rather than prompt over.
	if (extensionsResult?.errors?.length) {
		session.dispose();
		const detail = extensionsResult.errors.map((e) => `${e.path}: ${e.error}`).join("; ");
		throw new Error(
			`Isolated session has extension/resource diagnostics that must be resolved before prompting: ${detail}`,
		);
	}

	return {
		session,
		dispose: () => session.dispose(),
	};
}
