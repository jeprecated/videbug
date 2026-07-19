/**
 * Session-backed `AgentRunner` (implementation plan §8.1, §11).
 *
 * Wraps an isolated Pi session with the runtime controls the orchestration relies
 * on but must not itself implement:
 *   - a per-turn budget: abort the run once the agent exceeds `maxTurns` turns, so
 *     a looping model cannot spend unboundedly;
 *   - a wall-clock timeout: abort a prompt that runs longer than `timeoutMs`;
 *   - external cancellation via an `AbortSignal`;
 *   - progress events (tool calls, turns, notices) surfaced to the caller, which
 *     the CLI routes to stderr only — never model reasoning or frame contents.
 *
 * Event accounting comes from the runtime here, not from anything the model
 * claims. The runner never inspects results; the accepted analysis is read from
 * the submit-tool latch by the orchestration.
 */
import type { AgentRunner } from "./agent-runner.ts";

export interface SessionRunnerProgressEvent {
	type: "tool" | "turn" | "notice";
	message: string;
}

/** Minimal structural view of the session controls the runner uses. */
export interface RunnableSession {
	subscribe(listener: (event: { type: string; toolName?: string }) => void): () => void;
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
}

export interface RunnableSessionHandle {
	session: RunnableSession;
	dispose(): void;
}

export interface SessionRunnerOptions {
	/** Abort the run after this many agent turns per prompt (default: unbounded). */
	maxTurns?: number;
	/** Abort a prompt that runs longer than this (default: unbounded). */
	timeoutMs?: number;
	/** External cancellation. */
	signal?: AbortSignal;
	onProgress?: (event: SessionRunnerProgressEvent) => void;
}

export function createSessionRunner(handle: RunnableSessionHandle, options: SessionRunnerOptions = {}): AgentRunner {
	const { session } = handle;
	const emit = (type: SessionRunnerProgressEvent["type"], message: string) => options.onProgress?.({ type, message });

	let turnCount = 0;
	let aborting = false;

	const requestAbort = (reason: string) => {
		if (aborting) return;
		aborting = true;
		emit("notice", reason);
		void session.abort();
	};

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "turn_start") {
			turnCount += 1;
			// Show `turn N/max` when bounded so a human can gauge how much agent budget
			// remains; latency between turns is model-driven, so this is the honest signal
			// of progress (not a wall-clock percentage).
			emit("turn", options.maxTurns !== undefined ? `turn ${turnCount}/${options.maxTurns}` : `turn ${turnCount}`);
			if (options.maxTurns !== undefined && turnCount > options.maxTurns) {
				requestAbort(`turn budget exhausted (${options.maxTurns}); aborting`);
			}
		} else if (event.type === "tool_execution_start" && event.toolName) {
			emit("tool", event.toolName);
		}
	});

	return {
		async prompt(text: string): Promise<void> {
			turnCount = 0;
			aborting = false;

			let timer: ReturnType<typeof setTimeout> | undefined;
			if (options.timeoutMs !== undefined) {
				timer = setTimeout(() => requestAbort(`timeout after ${options.timeoutMs}ms; aborting`), options.timeoutMs);
			}

			const onSignal = () => requestAbort("cancelled; aborting");
			if (options.signal) {
				if (options.signal.aborted) requestAbort("cancelled before start; aborting");
				else options.signal.addEventListener("abort", onSignal, { once: true });
			}

			try {
				await session.prompt(text);
			} finally {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onSignal);
			}
		},

		async abort(): Promise<void> {
			requestAbort("abort requested");
		},

		dispose(): void {
			unsubscribe();
			handle.dispose();
		},
	};
}
