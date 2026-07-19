/**
 * Canonical JSON renderer.
 *
 * JSON is the authoritative output; the Markdown renderer is a pure function over
 * the same validated value. This renderer is deterministic (stable key order from
 * the constructed object, two-space indent, trailing newline) so snapshots and
 * round-trip tests are reproducible.
 */
import type { AnalysisResultV1 } from "../contracts/analysis-v1.ts";

export function renderJson(result: AnalysisResultV1): string {
	return `${JSON.stringify(result, null, 2)}\n`;
}
