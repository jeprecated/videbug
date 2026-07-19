import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EVIDENCE_ID_PATTERN, parseEvidenceId } from "../../src/evidence/evidence-id.ts";
import { extractEvidenceFrames } from "../../src/evidence/extract-evidence.ts";
import { buildFrameCatalog } from "../../src/video/probe.ts";
import { CFR_FIXTURE, ensureFixtures } from "../helpers/fixtures.ts";

beforeAll(async () => {
	await ensureFixtures();
});

function tempOut(): string {
	return mkdtempSync(join(tmpdir(), "v2d-evidence-"));
}

describe("extractEvidenceFrames", () => {
	it("produces registry-ready evidence records with stable IDs bound to the catalog", async () => {
		const catalog = await buildFrameCatalog(CFR_FIXTURE.path);
		const records = await extractEvidenceFrames(CFR_FIXTURE.path, [0, 5, 19], catalog, tempOut());

		expect(records).toHaveLength(3);
		expect(records.map((r) => r.ordinal)).toEqual([0, 5, 19]);
		expect(records.map((r) => r.ptsUs)).toEqual([0, 500_000, 1_900_000]);

		for (const record of records) {
			expect(EVIDENCE_ID_PATTERN.test(record.id)).toBe(true);
			expect(record.contentDigest).toMatch(/^[0-9a-f]{6}$/);
			expect(record.streamIndex).toBe(catalog.streamIndex);
			const parsed = parseEvidenceId(record.id);
			expect(parsed?.ordinal).toBe(record.ordinal);
			expect(parsed?.ptsMs).toBe(Math.round(record.ptsUs / 1000));
		}
	});

	it("binds distinct frames to distinct content digests (evidence, not just an ordinal label)", async () => {
		const catalog = await buildFrameCatalog(CFR_FIXTURE.path);
		const records = await extractEvidenceFrames(CFR_FIXTURE.path, [0, 10, 19], catalog, tempOut());
		const digests = new Set(records.map((r) => r.contentDigest));
		// testsrc frames differ, so their content digests should too.
		expect(digests.size).toBe(3);
	});

	it("fails closed on an out-of-range ordinal", async () => {
		const catalog = await buildFrameCatalog(CFR_FIXTURE.path);
		await expect(extractEvidenceFrames(CFR_FIXTURE.path, [0, 999], catalog, tempOut())).rejects.toThrow();
	});
});
