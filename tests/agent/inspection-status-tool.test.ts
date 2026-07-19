import { describe, expect, it } from "vitest";
import { createInspectionStatusTool } from "../../src/agent/tools/inspection-status-tool.ts";
import { BudgetLedger, DEFAULT_BUDGETS } from "../../src/evidence/budgets.ts";
import type { InspectionStatus } from "../../src/evidence/inspection-context.ts";

function status(): InspectionStatus {
	const ledger = new BudgetLedger(DEFAULT_BUDGETS);
	ledger.consume({ rangeInspections: 2, cells: 20 });
	return {
		budgets: ledger.usage(),
		registeredFrames: 20,
		inspectedRanges: [{ startMs: 0, endMs: 1000, reason: "chronology", samples: 10, density: 10 }],
		uninspectedCandidates: [{ kind: "transient", startMs: 5000, endMs: 5200, score: 950, representativeOrdinal: 150 }],
		mandatoryWindows: [
			{
				startMs: 5000,
				endMs: 5200,
				candidateCount: 1,
				kinds: ["transient"],
				uninspected: true,
				uncoveredSubsegments: [{ startMs: 5000, endMs: 5200 }],
			},
		],
		largeGaps: [{ startMs: 1000, endMs: 8000 }],
	};
}

describe("get_inspection_status tool", () => {
	it("renders budgets, inspected ranges, uninspected candidates and gaps as text", async () => {
		const tool = createInspectionStatusTool({ status });
		const result = await tool.execute("call-1", {});
		expect(result.content.every((c) => c.type === "text")).toBe(true);
		const text = result.content[0];
		if (text?.type === "text") {
			expect(text.text).toContain("rangeInspections: 2/12");
			expect(text.text).toContain("(chronology, 10 frames, 10.00 samples/s)");
			expect(text.text).toContain("Mandatory windows to cover before claiming 'complete':");
			expect(text.text).toContain("5000-5200ms [transient] UNINSPECTED");
			expect(text.text).toContain("still uncovered: 5000-5200ms");
			expect(text.text).toContain("Uninspected candidate windows (detail):");
			expect(text.text).toContain("transient 5000-5200ms");
			expect(text.text).toContain("Large uninspected temporal gaps:");
			expect(text.text).toContain("1000-8000ms");
		}
		expect(result.details.uninspectedCandidates).toBe(1);
		expect(result.details.uninspectedMandatoryWindows).toBe(1);
		expect(result.details.largeGaps).toBe(1);
		expect(result.details.remainingRangeInspections).toBe(10);
	});

	it("is named get_inspection_status and takes no parameters", () => {
		const tool = createInspectionStatusTool({ status });
		expect(tool.name).toBe("get_inspection_status");
		expect(Object.keys(tool.parameters.properties)).toHaveLength(0);
	});
});
