/**
 * Machine-readable JSON Schema derived from the canonical TypeBox contract.
 *
 * `AnalysisResultV1Schema` (typebox) is the single source of truth for the emitted
 * `--format json` report. TypeBox schemas are already JSON-Schema-shaped, so the
 * public schema is a deterministic projection of that value plus standard envelope
 * fields. The tracked artifact `schema/analysis-result.v1.schema.json` is generated
 * from this function (`npm run schema:export`) and a drift test fails if the two
 * diverge, so the published schema can never silently fall out of sync with the code.
 */
import { AnalysisResultV1Schema } from "./analysis-v1.ts";

/** Stable identifier for the version-1 analysis-result schema. */
export const ANALYSIS_RESULT_SCHEMA_ID = "https://videbug/schema/analysis-result.v1.schema.json";

/**
 * The canonical JSON Schema (draft-07) for a complete `AnalysisResultV1` report.
 * Pure and deterministic: structuredClone-free JSON round-trip drops TypeBox's
 * internal symbols, leaving plain JSON-Schema keywords.
 */
export function analysisResultJsonSchema(): Record<string, unknown> {
	const body = JSON.parse(JSON.stringify(AnalysisResultV1Schema)) as Record<string, unknown>;
	return {
		$schema: "http://json-schema.org/draft-07/schema#",
		$id: ANALYSIS_RESULT_SCHEMA_ID,
		title: "Videbug AnalysisResultV1",
		description:
			"A validated, evidence-backed debugging handoff produced from a screen recording. " +
			"Every evidence citation references a deterministic source frame ID whose embedded " +
			"presentation timestamp (PTS) is authoritative; the model never supplies source, " +
			'provenance, or timing values. schemaVersion is the literal "1".',
		...body,
	};
}

/** Deterministic pretty-printed serialization of the schema (trailing newline). */
export function analysisResultJsonSchemaText(): string {
	return `${JSON.stringify(analysisResultJsonSchema(), null, 2)}\n`;
}
