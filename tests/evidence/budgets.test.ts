import { describe, expect, it } from "vitest";
import { BudgetLedger, DEFAULT_BUDGETS, REVIEWER_BUDGETS } from "../../src/evidence/budgets.ts";

describe("BudgetLedger", () => {
	it("consumes within limits and reports remaining", () => {
		const ledger = new BudgetLedger(DEFAULT_BUDGETS);
		expect(ledger.consume({ rangeInspections: 1, cells: 10 })).toEqual({ ok: true });
		expect(ledger.remaining("rangeInspections")).toBe(DEFAULT_BUDGETS.rangeInspections - 1);
		expect(ledger.remaining("cells")).toBe(DEFAULT_BUDGETS.cells - 10);
	});

	it("rejects a request that exceeds a limit and consumes nothing (atomic)", () => {
		const ledger = new BudgetLedger({ ...DEFAULT_BUDGETS, comparisons: 1 });
		expect(ledger.consume({ comparisons: 1 })).toEqual({ ok: true });
		const rejected = ledger.consume({ comparisons: 1, cells: 5 });
		expect(rejected.ok).toBe(false);
		// The affordable `cells` portion must NOT have been consumed.
		expect(ledger.remaining("cells")).toBe(DEFAULT_BUDGETS.cells);
	});

	it("reports the exhausted category in the rejection message", () => {
		const ledger = new BudgetLedger({ ...DEFAULT_BUDGETS, fullResolutionFrames: 0 });
		const result = ledger.consume({ fullResolutionFrames: 1 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("fullResolutionFrames");
	});

	it("gives the reviewer strictly smaller count budgets than the analyst", () => {
		expect(REVIEWER_BUDGETS.rangeInspections).toBeLessThan(DEFAULT_BUDGETS.rangeInspections);
		expect(REVIEWER_BUDGETS.cells).toBeLessThan(DEFAULT_BUDGETS.cells);
		expect(REVIEWER_BUDGETS.comparisons).toBeLessThan(DEFAULT_BUDGETS.comparisons);
	});

	it("exposes a full usage snapshot", () => {
		const ledger = new BudgetLedger(DEFAULT_BUDGETS);
		ledger.consume({ overviewInspections: 2 });
		const usage = ledger.usage();
		expect(usage.overviewInspections).toEqual({
			used: 2,
			limit: DEFAULT_BUDGETS.overviewInspections,
			remaining: DEFAULT_BUDGETS.overviewInspections - 2,
		});
	});
});

describe("frozen budget guard (M7 mitigation must be budget-neutral)", () => {
	it("keeps the DEFAULT analyst budgets frozen (range=12, cells=250, full-res=12)", () => {
		expect(DEFAULT_BUDGETS.rangeInspections).toBe(12);
		expect(DEFAULT_BUDGETS.cells).toBe(250);
		expect(DEFAULT_BUDGETS.fullResolutionFrames).toBe(12);
		expect(DEFAULT_BUDGETS.overviewInspections).toBe(4);
		expect(DEFAULT_BUDGETS.comparisons).toBe(8);
	});

	it("keeps the REVIEWER budgets at half the analyst count budgets", () => {
		expect(REVIEWER_BUDGETS.rangeInspections).toBe(6);
		expect(REVIEWER_BUDGETS.cells).toBe(125);
		expect(REVIEWER_BUDGETS.fullResolutionFrames).toBe(6);
	});
});
