import { describe, expect, it } from "vitest";
import {
	buildInspectionPlan,
	buildProvenance,
	computeMandatoryMaxGroups,
	computeMandatoryMaxWindowMs,
	computeTailToleranceMs,
} from "../../src/app/analysis-common.ts";
import type { BudgetUsage } from "../../src/evidence/budgets.ts";
import type { InspectionContext } from "../../src/evidence/inspection-context.ts";
import type { MandatoryWindow } from "../../src/evidence/mandatory-windows.ts";

describe("buildProvenance reports ACTUAL spend, not the allowance ceiling", () => {
	it("sums used (not limit) across analyst + reviewer usages even under a huge auto allowance", () => {
		const analyst: BudgetUsage = {
			rangeInspections: { used: 24, limit: 95, remaining: 71 },
			overviewInspections: { used: 1, limit: 8, remaining: 7 },
			cells: { used: 512, limit: 2931, remaining: 2419 },
			fullResolutionFrames: { used: 3, limit: 30, remaining: 27 },
			comparisons: { used: 2, limit: 22, remaining: 20 },
		};
		const reviewer: BudgetUsage = {
			rangeInspections: { used: 5, limit: 86, remaining: 81 },
			overviewInspections: { used: 1, limit: 4, remaining: 3 },
			cells: { used: 90, limit: 2482, remaining: 2392 },
			fullResolutionFrames: { used: 1, limit: 19, remaining: 18 },
			comparisons: { used: 0, limit: 11, remaining: 11 },
		};
		const prov = buildProvenance([analyst, reviewer], {
			ffmpegVersion: "f",
			analystModel: "p/m",
			reviewerModel: "p/m",
			promptVersion: "analyst-v7+reviewer-v5",
		});
		// actual = (24+1+2) + (5+1+0) = 33 inspection calls; cells 512+90=602; full-res 3+1=4.
		expect(prov.inspectionCalls).toBe(33);
		expect(prov.inspectedCells).toBe(602);
		expect(prov.fullResolutionFrames).toBe(4);
		// It must never leak the allowance ceiling (95/2931/30...) as if it were spend.
		expect(prov.inspectionCalls).toBeLessThan(analyst.rangeInspections.limit);
		expect(prov.inspectedCells).toBeLessThan(analyst.cells.limit);
	});
});

describe("computeTailToleranceMs", () => {
	it("is one frame interval from the average fps, with a floor of 1", () => {
		expect(computeTailToleranceMs(25)).toBe(40);
		expect(computeTailToleranceMs(14.7)).toBe(69);
		expect(computeTailToleranceMs(0)).toBe(1000);
	});
});

describe("computeMandatoryMaxWindowMs", () => {
	it("aims for roughly rangeInspections windows with a floor", () => {
		expect(computeMandatoryMaxWindowMs(128640, 12)).toBe(10720);
		expect(computeMandatoryMaxWindowMs(6000, 12)).toBe(6000); // floor
	});
});

describe("buildInspectionPlan", () => {
	function context(
		windows: MandatoryWindow[],
		rangeInspections: number,
		cells: number,
		fullRes: number,
	): InspectionContext {
		return {
			mandatoryWindows: windows,
			budgets: { budgets: { rangeInspections, cells, fullResolutionFrames: fullRes } },
		} as unknown as InspectionContext;
	}

	it("counts dense and isolated obligations and reports the phase budget", () => {
		const windows: MandatoryWindow[] = [
			{ startMs: 0, endMs: 1000, candidateCount: 2, kinds: ["boundary"] },
			{ startMs: 2000, endMs: 3000, candidateCount: 1, kinds: ["transient"], minDensity: 6 },
			{ startMs: 4000, endMs: 4200, candidateCount: 1, kinds: ["transient"], minDensity: 6, peakOrdinals: [42, 43] },
		];
		expect(buildInspectionPlan("analyst", context(windows, 12, 250, 12))).toEqual({
			role: "analyst",
			mandatoryWindows: 3,
			denseWindows: 1,
			isolatedWindows: 1,
			isolatedPeaks: 2,
			rangeInspections: 12,
			cells: 250,
			fullResolutionFrames: 12,
		});
	});

	it("reflects the reviewer's own independent ledger values", () => {
		const plan = buildInspectionPlan("reviewer", context([], 6, 125, 6));
		expect(plan.role).toBe("reviewer");
		expect(plan.rangeInspections).toBe(6);
		expect(plan.cells).toBe(125);
		expect(plan.fullResolutionFrames).toBe(6);
		expect(plan.mandatoryWindows).toBe(0);
	});
});

describe("computeMandatoryMaxGroups", () => {
	it("caps mandatory windows below the range budget to reserve refinement calls", () => {
		// 12-call analyst budget -> reserve ~20% (2) -> at most 10 mandatory windows.
		expect(computeMandatoryMaxGroups(12)).toBe(10);
		// 6-call reviewer budget -> reserve at least 1 -> at most 5 windows.
		expect(computeMandatoryMaxGroups(6)).toBe(5);
		// Never below one window.
		expect(computeMandatoryMaxGroups(1)).toBe(1);
	});

	it("always leaves at least one spare inspect_range call", () => {
		for (const budget of [3, 6, 12, 24]) {
			expect(computeMandatoryMaxGroups(budget)).toBeLessThan(budget);
			expect(computeMandatoryMaxGroups(budget)).toBeGreaterThanOrEqual(1);
		}
	});
});
