import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ANALYSIS_RESULT_SCHEMA_ID,
	analysisResultJsonSchema,
	analysisResultJsonSchemaText,
} from "../../src/contracts/json-schema.ts";

const SCHEMA_PATH = join(import.meta.dirname, "..", "..", "schema", "analysis-result.v1.schema.json");

describe("analysis-result JSON Schema export", () => {
	it("the tracked schema file is in sync with the TypeBox contract (no drift)", () => {
		const onDisk = readFileSync(SCHEMA_PATH, "utf8");
		expect(onDisk).toBe(analysisResultJsonSchemaText());
	});

	it("carries a draft-07 envelope with a stable $id and title", () => {
		const schema = analysisResultJsonSchema();
		expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
		expect(schema.$id).toBe(ANALYSIS_RESULT_SCHEMA_ID);
		expect(schema.$id).toBe("https://videbug/schema/analysis-result.v1.schema.json");
		expect(schema.title).toBe("Videbug AnalysisResultV1");
		expect(schema.type).toBe("object");
	});

	it("documents the versioning, source, provenance, and citation fields", () => {
		const schema = analysisResultJsonSchema() as {
			required: string[];
			properties: Record<string, { properties?: Record<string, unknown>; items?: unknown }>;
		};
		// Top-level envelope requires the deterministic + semantic sections.
		for (const key of [
			"schemaVersion",
			"status",
			"coverage",
			"summary",
			"beats",
			"anomalies",
			"source",
			"provenance",
		]) {
			expect(schema.required).toContain(key);
		}
		// schemaVersion is pinned to the literal "1".
		expect((schema.properties.schemaVersion as { const?: string }).const).toBe("1");
		// Evidence citations expose frameId + ptsMs + role.
		const beatItems = (
			schema.properties.beats as {
				items: { properties: Record<string, { items?: { properties?: Record<string, unknown> } }> };
			}
		).items;
		const evidenceItem = beatItems.properties.evidence?.items?.properties as Record<string, unknown> | undefined;
		expect(evidenceItem).toBeDefined();
		expect(evidenceItem).toHaveProperty("frameId");
		expect(evidenceItem).toHaveProperty("ptsMs");
		expect(evidenceItem).toHaveProperty("role");
		// Deterministic source fingerprint documents the sha256 + fps + duration.
		const source = (schema.properties.source as { properties: Record<string, unknown> }).properties;
		for (const key of ["sha256", "durationMs", "width", "height", "averageFps"]) {
			expect(source).toHaveProperty(key);
		}
	});
});
