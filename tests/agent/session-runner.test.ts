import { describe, expect, it } from "vitest";
import { type RunnableSessionHandle, createSessionRunner } from "../../src/agent/session-runner.ts";

type Listener = (event: { type: string; toolName?: string }) => void;

/**
 * A fake AgentSession that lets a test drive events and control when a prompt
 * settles, so the runner's turn budget / timeout / abort logic is testable
 * without a model.
 */
class FakeSession {
	private listeners: Listener[] = [];
	aborts = 0;
	disposed = false;
	private resolvePrompt?: () => void;

	subscribe(listener: Listener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	emit(event: { type: string; toolName?: string }): void {
		for (const l of this.listeners) l(event);
	}

	prompt(): Promise<void> {
		return new Promise((resolve) => {
			this.resolvePrompt = resolve;
		});
	}

	settle(): void {
		this.resolvePrompt?.();
	}

	async abort(): Promise<void> {
		this.aborts += 1;
		// A real session settles its prompt after an abort.
		this.settle();
	}
}

function handleFor(session: FakeSession): { handle: RunnableSessionHandle; disposed: () => boolean } {
	let disposed = false;
	return {
		handle: {
			session: session as unknown as RunnableSessionHandle["session"],
			dispose: () => {
				disposed = true;
			},
		},
		disposed: () => disposed,
	};
}

describe("createSessionRunner", () => {
	it("emits tool and turn progress from runtime events", async () => {
		const session = new FakeSession();
		const { handle } = handleFor(session);
		const events: string[] = [];
		const runner = createSessionRunner(handle, { onProgress: (e) => events.push(`${e.type}:${e.message}`) });

		const p = runner.prompt("go");
		session.emit({ type: "turn_start" });
		session.emit({ type: "tool_execution_start", toolName: "inspect_overview" });
		session.settle();
		await p;

		expect(events).toContain("turn:turn 1");
		expect(events).toContain("tool:inspect_overview");
	});

	it("labels turns as `turn N/max` when a turn budget is set", async () => {
		const session = new FakeSession();
		const { handle } = handleFor(session);
		const events: string[] = [];
		const runner = createSessionRunner(handle, {
			maxTurns: 20,
			onProgress: (e) => events.push(`${e.type}:${e.message}`),
		});

		const p = runner.prompt("go");
		session.emit({ type: "turn_start" });
		session.emit({ type: "turn_start" });
		session.settle();
		await p;

		expect(events).toContain("turn:turn 1/20");
		expect(events).toContain("turn:turn 2/20");
	});

	it("aborts the run when the turn budget is exceeded", async () => {
		const session = new FakeSession();
		const { handle } = handleFor(session);
		const runner = createSessionRunner(handle, { maxTurns: 2 });

		const p = runner.prompt("go");
		session.emit({ type: "turn_start" });
		session.emit({ type: "turn_start" });
		expect(session.aborts).toBe(0);
		session.emit({ type: "turn_start" }); // exceeds maxTurns=2
		await p;
		expect(session.aborts).toBe(1);
	});

	it("aborts on timeout", async () => {
		const session = new FakeSession();
		const { handle } = handleFor(session);
		const runner = createSessionRunner(handle, { timeoutMs: 10 });
		await runner.prompt("go"); // timeout fires -> abort -> prompt settles
		expect(session.aborts).toBe(1);
	});

	it("aborts when an external signal fires", async () => {
		const session = new FakeSession();
		const { handle } = handleFor(session);
		const controller = new AbortController();
		const runner = createSessionRunner(handle, { signal: controller.signal });
		const p = runner.prompt("go");
		controller.abort();
		await p;
		expect(session.aborts).toBe(1);
	});

	it("disposes the underlying handle and unsubscribes", async () => {
		const session = new FakeSession();
		const { handle, disposed } = handleFor(session);
		const runner = createSessionRunner(handle, {});
		runner.dispose();
		expect(disposed()).toBe(true);
		// After unsubscribe, further events are ignored (no throw).
		session.emit({ type: "turn_start" });
	});
});
