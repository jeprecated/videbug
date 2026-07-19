import { describe, expect, it } from "vitest";
import { createCompareEvidenceTool } from "../../src/agent/tools/compare-evidence-tool.ts";
import type { ComparisonResult } from "../../src/evidence/compare.ts";

// A recognisable, non-uniform 8x8 grid: cell k holds k/100 so specific values can
// be asserted in both the rendered text and the exact details payload.
const GRID = Array.from({ length: 64 }, (_, k) => k / 100);

function comparison(): ComparisonResult {
	return {
		frameIds: ["a", "b"],
		pairs: [
			{
				fromId: "a",
				toId: "b",
				absDiffMean: 210.5,
				changedPixelRatio: 0.98,
				dHashDistance: 30,
				changedCells: 64,
				grid: GRID,
			},
		],
	};
}

describe("compare_evidence tool", () => {
	it("returns deterministic metrics as text and no image", async () => {
		const tool = createCompareEvidenceTool({ runCompare: async () => comparison() });
		const result = await tool.execute("call-1", { frameIds: ["a", "b"] });
		expect(result.content.every((c) => c.type === "text")).toBe(true);
		const text = result.content[0];
		expect(text?.type === "text" && text.text).toContain("a -> b");
		expect(text?.type === "text" && text.text).toContain("changedCells=64/64");
		expect(result.details).toMatchObject({ accepted: true, pairs: 1 });
	});

	it("exposes the actual 8x8 changed-region grid in both text and details", async () => {
		const tool = createCompareEvidenceTool({ runCompare: async () => comparison() });
		const result = await tool.execute("call-1", { frameIds: ["a", "b"] });
		const text = result.content[0];
		if (text?.type !== "text") throw new Error("expected text content");
		// Text carries the rendered grid: a labelled header and the last row's values.
		expect(text.text).toContain("changed-region grid (8x8, changed-pixel ratio per cell, row-major):");
		expect(text.text).toContain("0.56 0.57 0.58 0.59 0.60 0.61 0.62 0.63");
		// Details carry the exact, authoritative grid arrays.
		expect(result.details.comparisons).toHaveLength(1);
		expect(result.details.comparisons?.[0]).toMatchObject({ fromId: "a", toId: "b", changedCells: 64 });
		expect(result.details.comparisons?.[0]?.grid).toEqual(GRID);
		expect(result.details.comparisons?.[0]?.grid).toHaveLength(64);
	});

	it("rejects an unregistered frame ID via the backend rejection", async () => {
		const tool = createCompareEvidenceTool({
			runCompare: async () => ({
				ok: false,
				message: 'Frame ID "../../etc/passwd" is not registered; cannot compare.',
			}),
		});
		const result = await tool.execute("call-1", { frameIds: ["../../etc/passwd", "b"] });
		expect(result.details.accepted).toBe(false);
		expect(result.content[0]?.type === "text" && result.content[0].text).toContain("not registered");
	});

	it("requires at least two frame IDs in the schema", () => {
		const tool = createCompareEvidenceTool({ runCompare: async () => comparison() });
		expect(tool.name).toBe("compare_evidence");
		expect((tool.parameters.properties.frameIds as { minItems?: number }).minItems).toBe(2);
	});
});
