import type { AgentRunner } from "../../src/agent/agent-runner.ts";

/**
 * A deterministic scripted fake `AgentRunner` for orchestration tests.
 *
 * Each `prompt()` runs the handler at the matching turn index, simulating what a
 * model would do that turn (e.g. call the real submit tool with a payload). It
 * records every prompt it received and every abort/dispose call, so tests can
 * assert exactly how many turns and repair prompts the orchestration issued.
 */
export type ScriptedTurn = (text: string, turn: number) => void | Promise<void>;

export class ScriptedAgentRunner implements AgentRunner {
	readonly prompts: string[] = [];
	aborts = 0;
	disposed = false;

	constructor(private readonly turns: ScriptedTurn[] = []) {}

	async prompt(text: string): Promise<void> {
		const turn = this.prompts.length;
		this.prompts.push(text);
		const handler = this.turns[turn];
		if (handler) await handler(text, turn);
	}

	async abort(): Promise<void> {
		this.aborts += 1;
	}

	dispose(): void {
		this.disposed = true;
	}
}
