/**
 * `AgentRunner`: the seam between analyst orchestration and a live Pi session.
 *
 * Orchestration (initial briefing, submission check, exactly one bounded repair
 * turn) is expressed purely against this interface, so it can be exercised
 * deterministically with a scripted fake runner — no model cost, no network — and
 * the same orchestration drives the real session-backed runner in production.
 *
 * A runner owns exactly one turn-taking primitive (`prompt`) plus lifecycle
 * (`abort`, `dispose`). It never interprets results: the accepted analysis is read
 * from the submit-tool latch, not from anything the runner returns.
 */
export interface AgentRunner {
	/** Send one user turn and resolve when the agent settles (or is aborted). */
	prompt(text: string): Promise<void>;
	/** Best-effort cancellation of any in-flight turn. */
	abort(): Promise<void>;
	/** Release all resources. Safe to call more than once. */
	dispose(): void;
}
