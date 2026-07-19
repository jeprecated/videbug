#!/usr/bin/env node
/**
 * Write the canonical JSON Schema to `schema/analysis-result.v1.schema.json`.
 *
 * The schema is derived from the TypeBox contract (`src/contracts/json-schema.ts`),
 * so this script only serializes it to the tracked artifact. A drift test
 * (`tests/contracts/json-schema.test.ts`) fails if the tracked file ever diverges
 * from the code, so the published schema stays in lockstep with the contract.
 *
 * Usage: node scripts/export-schema.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// Import the TypeScript source directly via Node's type-stripping.
const { analysisResultJsonSchemaText } = await import("../src/contracts/json-schema.ts");

const outPath = join(repoRoot, "schema", "analysis-result.v1.schema.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, analysisResultJsonSchemaText());
process.stderr.write(`wrote ${outPath}\n`);
