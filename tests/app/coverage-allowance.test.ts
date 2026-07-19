import { describe, expect, it } from "vitest";
import {
	type CoverageComplexity,
	computeAllowancePlan,
	frozenAllowancePlan,
	isLongOrBusy,
} from "../../src/app/coverage-allowance.ts";
import { DEFAULT_BUDGETS, REVIEWER_BUDGETS } from "../../src/evidence/budgets.ts";
import { clusterIsolatedFocusWindows } from "../../src/evidence/mandatory-windows.ts";

// The regression profile: the real 4:18 / 179-candidate run that became partial
// solely because the analyst hit 12/12 ranges and the reviewer 6/6.
const REGRESSION: CoverageComplexity = {
	durationMs: 258228,
	averageFps: 13.48,
	frameCount: 3480,
	candidateCount: 179,
	isolatedTransientCount: 0,
};

const SHORT: CoverageComplexity = {
	durationMs: 8000,
	averageFps: 10,
	frameCount: 80,
	candidateCount: 5,
	isolatedTransientCount: 0,
};

describe("computeAllowancePlan — regression profile (4:18 / 179 candidates)", () => {
	const plan = computeAllowancePlan(REGRESSION);

	it("scales the analyst materially above the historical 12/250/12 caps", () => {
		expect(plan.analyst.budgets.rangeInspections).toBeGreaterThan(DEFAULT_BUDGETS.rangeInspections);
		expect(plan.analyst.budgets.cells).toBeGreaterThan(DEFAULT_BUDGETS.cells);
		expect(plan.analyst.budgets.fullResolutionFrames).toBeGreaterThan(DEFAULT_BUDGETS.fullResolutionFrames);
		// concretely well beyond the old dozen
		expect(plan.analyst.budgets.rangeInspections).toBe(95);
		expect(plan.analyst.budgets.fullResolutionFrames).toBe(30);
		expect(plan.analyst.budgets.cells).toBe(2931);
	});

	it("scales the reviewer materially above the historical 6/125/6 caps (independent allowance)", () => {
		expect(plan.reviewer.budgets.rangeInspections).toBeGreaterThan(REVIEWER_BUDGETS.rangeInspections);
		expect(plan.reviewer.budgets.cells).toBeGreaterThan(REVIEWER_BUDGETS.cells);
		expect(plan.reviewer.budgets.fullResolutionFrames).toBeGreaterThan(REVIEWER_BUDGETS.fullResolutionFrames);
		expect(plan.reviewer.budgets.rangeInspections).toBe(86);
		expect(plan.reviewer.budgets.fullResolutionFrames).toBe(19);
	});

	it("upper-bounds the deterministic obligations: mandatory groups + >=5s gaps + isolated windows", () => {
		expect(plan.maxChronologyGaps).toBe(52);
		expect(plan.analyst.mandatoryGroups).toBe(22);
		expect(plan.analyst.isolatedMaxWindows).toBe(4);
		const coverageObligation =
			plan.analyst.mandatoryGroups + plan.maxChronologyGaps + plan.analyst.isolatedMaxWindows + 3; // default transient-focus windows, covered by refinement headroom
		expect(plan.analyst.budgets.rangeInspections).toBeGreaterThanOrEqual(coverageObligation);
		expect(plan.reviewer.budgets.rangeInspections).toBeGreaterThanOrEqual(coverageObligation);
		// full-res covers every isolated peak obligation plus refinement headroom.
		expect(plan.analyst.budgets.fullResolutionFrames).toBeGreaterThanOrEqual(plan.analyst.isolatedMaxPeaks);
	});

	it("decouples plan groups from the high ceiling (does not make 179 mandatory sheets)", () => {
		expect(plan.analyst.mandatoryGroups).toBeLessThan(REGRESSION.candidateCount);
		expect(plan.analyst.mandatoryGroups).toBeLessThan(plan.analyst.budgets.rangeInspections);
		// leaves ample refinement allowance beyond just covering the groups once.
		expect(plan.analyst.budgets.rangeInspections - plan.analyst.mandatoryGroups).toBeGreaterThan(10);
	});

	it("reports an estimated-max frames/cells and images for the busy-video warning", () => {
		expect(plan.analyst.estimatedMaxCells).toBeGreaterThanOrEqual(plan.analyst.budgets.cells);
		expect(plan.analyst.estimatedMaxImages).toBeGreaterThan(0);
		expect(isLongOrBusy(REGRESSION)).toBe(true);
	});
});

describe("computeAllowancePlan — long recordings have no fixed production clamp", () => {
	for (const [label, durationMs] of [
		["30 minutes", 30 * 60 * 1000],
		["1 hour", 60 * 60 * 1000],
	] as const) {
		it(`${label}: scales groups and every role above all computed range/cell obligations`, () => {
			const profile: CoverageComplexity = {
				durationMs,
				averageFps: 30,
				frameCount: Math.round((durationMs / 1000) * 30),
				candidateCount: Math.round(durationMs / 1000),
				isolatedTransientCount: label === "1 hour" ? 250 : 100,
			};
			const plan = computeAllowancePlan(profile);
			const expectedGroups = Math.round(durationMs / 12000);
			const expectedGaps = Math.ceil(durationMs / 5000);
			expect(plan.analyst.mandatoryGroups).toBe(expectedGroups);
			expect(plan.maxChronologyGaps).toBe(expectedGaps);
			for (const role of [plan.analyst, plan.reviewer]) {
				const rangeObligation = expectedGroups + expectedGaps + role.isolatedMaxWindows + 3;
				expect(role.budgets.rangeInspections).toBeGreaterThanOrEqual(rangeObligation);
				expect(role.budgets.cells).toBeGreaterThanOrEqual(
					role.budgets.rangeInspections * 24 + role.budgets.overviewInspections * (48 + profile.isolatedTransientCount),
				);
				expect(role.budgets.fullResolutionFrames).toBeGreaterThanOrEqual(role.isolatedMaxPeaks);
			}
		});
	}

	it("keeps the exact one-hour values finite, safe, and above the removed global caps", () => {
		const plan = computeAllowancePlan({
			durationMs: 3_600_000,
			averageFps: 30,
			frameCount: 108_000,
			candidateCount: 3600,
			isolatedTransientCount: 250,
		});
		expect(plan.analyst.mandatoryGroups).toBe(300);
		expect(plan.maxChronologyGaps).toBe(720);
		expect(plan.analyst.budgets.rangeInspections).toBe(1495);
		expect(plan.analyst.budgets.cells).toBe(42_091);
		expect(plan.analyst.budgets.fullResolutionFrames).toBe(550);
		expect(plan.reviewer.budgets.rangeInspections).toBe(1375);
		expect(plan.reviewer.budgets.cells).toBe(37_612);
		expect(plan.reviewer.budgets.fullResolutionFrames).toBe(400);
		for (const value of Object.values(plan.analyst.budgets)) {
			expect(Number.isFinite(value)).toBe(true);
			expect(Number.isSafeInteger(value)).toBe(true);
		}
	});

	it("fails clearly for impossible/non-finite source complexity instead of silently clamping", () => {
		expect(() => computeAllowancePlan({ ...REGRESSION, durationMs: Number.POSITIVE_INFINITY })).toThrow(
			/invalid coverage complexity.*durationMs/i,
		);
		expect(() => computeAllowancePlan({ ...REGRESSION, isolatedTransientCount: Number.MAX_SAFE_INTEGER })).toThrow(
			/derived allowance.*safe integer/i,
		);
	});
});

describe("computeAllowancePlan — short/simple profile stays a sensible minimum", () => {
	const plan = computeAllowancePlan(SHORT);
	const long = computeAllowancePlan(REGRESSION);

	it("never drops below the historical minimums", () => {
		expect(plan.analyst.budgets.rangeInspections).toBeGreaterThanOrEqual(DEFAULT_BUDGETS.rangeInspections);
		expect(plan.analyst.budgets.cells).toBeGreaterThanOrEqual(DEFAULT_BUDGETS.cells);
		expect(plan.analyst.budgets.fullResolutionFrames).toBeGreaterThanOrEqual(DEFAULT_BUDGETS.fullResolutionFrames);
		expect(plan.reviewer.budgets.rangeInspections).toBeGreaterThanOrEqual(REVIEWER_BUDGETS.rangeInspections);
	});

	it("stays far below the long/busy profile and does not warn", () => {
		expect(plan.analyst.budgets.rangeInspections).toBeLessThan(long.analyst.budgets.rangeInspections);
		expect(plan.analyst.budgets.rangeInspections).toBeLessThanOrEqual(40);
		expect(isLongOrBusy(SHORT)).toBe(false);
	});
});

describe("auto isolated sizing eliminates fixed-cap overflow", () => {
	it("sizes isolated windows/peaks from the detected count so clustering never overflows on caps alone", () => {
		const c: CoverageComplexity = { ...REGRESSION, isolatedTransientCount: 5 };
		const plan = computeAllowancePlan(c);
		expect(plan.analyst.isolatedMaxWindows).toBeGreaterThanOrEqual(5);
		expect(plan.analyst.isolatedMaxPeaks).toBeGreaterThanOrEqual(5);
		// Five isolated transients, each in its own cluster, must NOT overflow.
		const isolatedInputs = Array.from({ length: 5 }, (_, i) => ({
			startMs: i * 20000,
			endMs: i * 20000 + 100,
			peakOrdinal: i * 200,
			peakRatio: 0.4,
		}));
		const { windows, overflow } = clusterIsolatedFocusWindows(isolatedInputs, {
			mergeGapMs: 2000,
			minDensity: 6,
			maxWindows: plan.analyst.isolatedMaxWindows,
			maxPeaks: plan.analyst.isolatedMaxPeaks,
		});
		expect(overflow).toHaveLength(0);
		expect(windows.length).toBe(5);
	});
});

describe("frozenAllowancePlan — historical evaluation reproducibility", () => {
	const plan = frozenAllowancePlan(258228);

	it("pins the analyst and reviewer to the frozen 12/250/12 + reviewer-half budgets", () => {
		expect(plan.auto).toBe(false);
		expect(plan.analyst.budgets).toEqual(DEFAULT_BUDGETS);
		expect(plan.reviewer.budgets).toEqual(REVIEWER_BUDGETS);
		// frozen group math: analyst 10 windows, reviewer 5.
		expect(plan.analyst.mandatoryGroups).toBe(10);
		expect(plan.reviewer.mandatoryGroups).toBe(5);
	});
});
