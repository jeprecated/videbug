import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";

/**
 * Narrow, directly-callable view of a Pi custom tool.
 *
 * The Pi SDK's `ToolDefinition.execute` takes trailing runtime arguments
 * (`signal`, `onUpdate`, `ctx`) supplied by the agent loop. For our custom video
 * tools none of those are needed, so we expose a two-argument `execute` that the
 * CLI and unit tests can call directly. A function that accepts fewer parameters
 * remains assignable to the SDK's wider `ToolDefinition`, so these tools can still
 * be handed to `createAgentSession({ customTools })` unchanged.
 */
export interface CustomVideoTool<TParams extends TSchema, TDetails> {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: TParams;
	execute(toolCallId: string, params: Static<TParams>): Promise<AgentToolResult<TDetails>>;
}
