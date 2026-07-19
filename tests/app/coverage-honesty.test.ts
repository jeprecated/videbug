import { describe, expect, it } from "vitest";
import {
	computeUncoveredSegments,
	coverageHonestyErrors,
	prematurePartialErrors,
} from "../../src/app/coverage-honesty.ts";
import type { SubmitAnalysisPayload } from "../../src/contracts/analysis-v1.ts";
import type { InspectionStatus } from "../../src/evidence/inspection-context.ts";

function status(overrides: Partial<InspectionStatus> = {}): InspectionStatus {
	return {
		budgets: {} as InspectionStatus["budgets"],
		registeredFrames: 0,
		inspectedRanges: [],
		uninspectedCandidates: [],
		mandatoryWindows: [],
		largeGaps: [],
		...overrides,
	};
}

const PEAK_FRAME_ID = "v0_f000000660_p000044000_abcdef";

function mixedIsolatedStatus(options: {
	spanUncovered: boolean;
	peakUnread: boolean;
	overflow?: boolean;
}): InspectionStatus {
	return status({
		mandatoryWindows: [
			{
				startMs: 43000,
				endMs: 44000,
				candidateCount: 1,
				kinds: ["isolated-transient"],
				minDensity: 6,
				peakOrdinals: [660],
				uninspected: options.spanUncovered || options.peakUnread,
				uncoveredSubsegments: options.spanUncovered ? [{ startMs: 43000, endMs: 43800 }] : [],
				peakOrdinalsNeedingFullRes: options.peakUnread ? [660] : [],
				peakFrameIds: options.peakUnread ? [PEAK_FRAME_ID] : [],
			},
		],
		...(options.overflow ? { unsatisfiedIsolatedTransients: [{ startMs: 47000, endMs: 47100 }] } : {}),
	});
}

function payload(overrides: Partial<SubmitAnalysisPayload> = {}): SubmitAnalysisPayload {
	return {
		schemaVersion: "1",
		status: "complete",
		coverage: { analyzedStartMs: 0, analyzedEndMs: 10000, uninspectedRanges: [], confidence: "high" },
		summary: { observedFailure: "x", chronology: "y" },
		beats: [],
		anomalies: [],
		handoff: { reproductionSteps: [], suggestedInvestigations: [], uncertainties: [] },
		...overrides,
	};
}

describe("computeUncoveredSegments", () => {
	it("collects uninspected mandatory windows and large gaps", () => {
		const segs = computeUncoveredSegments(
			status({
				mandatoryWindows: [
					{
						startMs: 1000,
						endMs: 2000,
						candidateCount: 1,
						kinds: ["boundary"],
						uninspected: true,
						uncoveredSubsegments: [{ startMs: 1000, endMs: 2000 }],
					},
					{
						startMs: 3000,
						endMs: 4000,
						candidateCount: 1,
						kinds: ["stable"],
						uninspected: false,
						uncoveredSubsegments: [],
					},
				],
				largeGaps: [{ startMs: 8000, endMs: 10000 }],
			}),
		);
		expect(segs).toHaveLength(2);
		expect(segs[0]).toMatchObject({ startMs: 1000, endMs: 2000 });
		expect(segs[1]).toMatchObject({ startMs: 8000, endMs: 10000 });
	});

	it("fails closed on an isolated-transient focus window whose peak has NOT had a full-resolution read (dense coverage alone is not enough)", () => {
		const segs = computeUncoveredSegments(
			status({
				mandatoryWindows: [
					{
						startMs: 43867,
						endMs: 44000,
						candidateCount: 1,
						kinds: ["isolated-transient"],
						minDensity: 6,
						peakOrdinals: [660],
						// Densely covered (no span gap) but the peak is still unread -> uninspected.
						uninspected: true,
						uncoveredSubsegments: [],
						peakOrdinalsNeedingFullRes: [660],
						peakFrameIds: ["v0_f000000660_p000044000_abcdef"],
					},
				],
			}),
		);
		expect(segs).toHaveLength(1);
		expect(segs[0]).toMatchObject({
			startMs: 43867,
			endMs: 44000,
			requiredTool: "inspect_frame",
			frameIds: ["v0_f000000660_p000044000_abcdef"],
		});
		expect(segs[0]!.reason).toMatch(/full-resolution read/);
		expect(segs[0]!.reason).not.toContain("v0_f000000660_p000044000_abcdef");
	});

	it("emits independent range and full-resolution obligations for the same isolated window", () => {
		const both = computeUncoveredSegments(mixedIsolatedStatus({ spanUncovered: true, peakUnread: true }));
		expect(both).toHaveLength(2);
		expect(both.map((s) => s.requiredTool)).toEqual(["inspect_range", "inspect_frame"]);
		expect(both[0]).toMatchObject({ startMs: 43000, endMs: 43800 });
		expect(both[1]).toMatchObject({ startMs: 43000, endMs: 44000, frameIds: [PEAK_FRAME_ID] });

		const peakCleared = computeUncoveredSegments(mixedIsolatedStatus({ spanUncovered: true, peakUnread: false }));
		expect(peakCleared.map((s) => s.requiredTool)).toEqual(["inspect_range"]);

		const spanCleared = computeUncoveredSegments(mixedIsolatedStatus({ spanUncovered: false, peakUnread: true }));
		expect(spanCleared.map((s) => s.requiredTool)).toEqual(["inspect_frame"]);

		expect(computeUncoveredSegments(mixedIsolatedStatus({ spanUncovered: false, peakUnread: false }))).toEqual([]);
	});

	it("keeps an overflow obligation alongside both coverable isolated-window obligations", () => {
		const segments = computeUncoveredSegments(
			mixedIsolatedStatus({ spanUncovered: true, peakUnread: true, overflow: true }),
		);
		expect(segments.map((s) => s.requiredTool)).toEqual(["inspect_range", "inspect_frame", "uncoverable"]);
	});

	it("treats overflow isolated transients (over the focus budget) as uncovered -> forces honest partial", () => {
		const segs = computeUncoveredSegments(
			status({ unsatisfiedIsolatedTransients: [{ startMs: 19267, endMs: 19268 }] }),
		);
		expect(segs).toHaveLength(1);
		expect(segs[0]).toMatchObject({ startMs: 19267, endMs: 19268 });
		expect(segs[0]!.reason).toMatch(/over the focus budget/);
	});

	it("reports only the canonical uncovered SUBSEGMENTS of a partially-inspected window", () => {
		// A wide mandatory window is mostly covered; only a genuine interior gap remains.
		// The whole window must NOT be reported — just its uncovered sub-part.
		const segs = computeUncoveredSegments(
			status({
				mandatoryWindows: [
					{
						startMs: 1000,
						endMs: 9000,
						candidateCount: 3,
						kinds: ["boundary", "stable"],
						uninspected: true,
						uncoveredSubsegments: [{ startMs: 4000, endMs: 5500 }],
					},
				],
			}),
		);
		expect(segs).toHaveLength(1);
		expect(segs[0]).toMatchObject({ startMs: 4000, endMs: 5500, reason: "mandatory activity window" });
	});
});

describe("coverageHonestyErrors", () => {
	it("passes a complete claim when nothing is uncovered", () => {
		expect(coverageHonestyErrors(payload({ status: "complete" }), [])).toEqual([]);
	});

	it("rejects a complete claim while a mandatory window is uninspected", () => {
		const errors = coverageHonestyErrors(payload({ status: "complete" }), [
			{ startMs: 1000, endMs: 2000, reason: "mandatory window" },
		]);
		expect(errors.length).toBe(1);
		expect(errors[0]).toMatch(/complete/);
		expect(errors[0]).toMatch(/1000-2000/);
	});

	it("rejects a complete claim while a large recording gap is uninspected", () => {
		const errors = coverageHonestyErrors(payload({ status: "complete" }), [
			{ startMs: 8000, endMs: 10000, reason: "large uninspected gap" },
		]);
		expect(errors.length).toBe(1);
		expect(errors[0]).toMatch(/gap/i);
		expect(errors[0]).toMatch(/inspect_range/);
	});

	it("directs a complete claim with an unread isolated peak to inspect_frame", () => {
		const errors = coverageHonestyErrors(payload({ status: "complete" }), [
			{
				startMs: 43867,
				endMs: 44000,
				reason: "isolated transient peak needing a full-resolution read",
				requiredTool: "inspect_frame",
				frameIds: ["v0_f000000660_p000044000_abcdef"],
			},
		]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/inspect_frame/);
		expect(errors[0]).not.toMatch(/inspect_range/);
		expect(errors[0]).toContain("v0_f000000660_p000044000_abcdef");
	});

	it("accepts a partial submission that lists every uncovered segment (contained in declared ranges)", () => {
		const p = payload({
			status: "partial",
			coverage: {
				analyzedStartMs: 0,
				analyzedEndMs: 8000,
				uninspectedRanges: [
					{ startMs: 1000, endMs: 2000 },
					{ startMs: 7000, endMs: 10000 },
				],
				confidence: "medium",
			},
		});
		const errors = coverageHonestyErrors(p, [
			{ startMs: 1000, endMs: 2000, reason: "mandatory window" },
			{ startMs: 8000, endMs: 10000, reason: "large uninspected gap" },
		]);
		expect(errors).toEqual([]);
	});

	it("rejects a partial submission that omits a genuinely uncovered segment", () => {
		const p = payload({
			status: "partial",
			coverage: {
				analyzedStartMs: 0,
				analyzedEndMs: 8000,
				uninspectedRanges: [{ startMs: 1000, endMs: 2000 }],
				confidence: "medium",
			},
		});
		const errors = coverageHonestyErrors(p, [
			{ startMs: 1000, endMs: 2000, reason: "mandatory window" },
			{ startMs: 8000, endMs: 10000, reason: "large uninspected gap" },
		]);
		expect(errors.length).toBe(1);
		expect(errors[0]).toMatch(/8000-10000/);
		expect(errors[0]).toMatch(/uninspectedRanges/);
	});
});

describe("prematurePartialErrors (production auto-coverage guard)", () => {
	const twoGaps = [
		{ startMs: 50522, endMs: 60309, reason: "large uninspected recording gap" },
		{ startMs: 114669, endMs: 124265, reason: "large uninspected recording gap" },
	];
	const partial = payload({
		status: "partial",
		coverage: {
			analyzedStartMs: 0,
			analyzedEndMs: 258228,
			uninspectedRanges: [
				{ startMs: 50522, endMs: 60309 },
				{ startMs: 114669, endMs: 124265 },
			],
			confidence: "medium",
		},
	});

	it("rejects a production partial with two gaps while range and cell allowance remain", () => {
		// The exact regression: honestly-listed gaps, but budget still available.
		const errors = prematurePartialErrors(partial, twoGaps, {
			rangeInspections: 60,
			cells: 1800,
			fullResolutionFrames: 20,
		});
		expect(errors.length).toBe(1);
		expect(errors[0]).toMatch(/2 range-coverable segment/);
		expect(errors[0]).toMatch(/60 inspect_range/);
		expect(errors[0]).toMatch(/complete/);
		expect(errors[0]).toMatch(/50522-60309ms/);
	});

	it("rejects while even one or two cells remain spendable for a range obligation", () => {
		for (const cells of [1, 2]) {
			const errors = prematurePartialErrors(partial, twoGaps, {
				rangeInspections: 5,
				cells,
				fullResolutionFrames: 0,
			});
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatch(new RegExp(`still have 5 inspect_range call\\(s\\) and ${cells} cell\\(s\\)`));
		}
	});

	it("accepts an honest range partial only when calls or cells are genuinely exhausted", () => {
		expect(
			prematurePartialErrors(partial, twoGaps, { rangeInspections: 0, cells: 2, fullResolutionFrames: 0 }),
		).toEqual([]);
		expect(
			prematurePartialErrors(partial, twoGaps, { rangeInspections: 5, cells: 0, fullResolutionFrames: 0 }),
		).toEqual([]);
	});

	it("accepts an honest partial when only a true focus-budget overflow remains (uncoverable)", () => {
		const overflowOnly = [{ startMs: 300, endMs: 400, reason: "isolated transient over the focus budget" }];
		expect(
			prematurePartialErrors(partial, overflowOnly, { rangeInspections: 60, cells: 1800, fullResolutionFrames: 20 }),
		).toEqual([]);
	});

	it("uses full-resolution allowance—not range allowance—for a peak-only obligation", () => {
		const peakOnly = [
			{
				startMs: 43867,
				endMs: 44000,
				reason: "isolated transient peak needing a full-resolution read",
				requiredTool: "inspect_frame" as const,
				frameIds: ["v0_f000000660_p000044000_abcdef"],
			},
		];

		const actionable = prematurePartialErrors(partial, peakOnly, {
			rangeInspections: 0,
			cells: 0,
			fullResolutionFrames: 2,
		});
		expect(actionable).toHaveLength(1);
		expect(actionable[0]).toMatch(/2 full-resolution frame read/);
		expect(actionable[0]).toMatch(/inspect_frame/);
		expect(actionable[0]).toContain("v0_f000000660_p000044000_abcdef");
		expect(actionable[0]).not.toMatch(/inspect_range/);

		// Range/cell headroom cannot clear an unread peak once full-res is exhausted.
		expect(
			prematurePartialErrors(partial, peakOnly, {
				rangeInspections: 60,
				cells: 1800,
				fullResolutionFrames: 0,
			}),
		).toEqual([]);
	});

	it("guards canonical mixed isolated-window obligations by each independently spendable resource", () => {
		const canonical = computeUncoveredSegments(mixedIsolatedStatus({ spanUncovered: true, peakUnread: true }));

		const bothAvailable = prematurePartialErrors(partial, canonical, {
			rangeInspections: 2,
			cells: 48,
			fullResolutionFrames: 1,
		});
		expect(bothAvailable).toHaveLength(2);
		expect(bothAvailable[0]).toMatch(/inspect_range/);
		expect(bothAvailable[1]).toMatch(/inspect_frame/);

		const frameOnly = prematurePartialErrors(partial, canonical, {
			rangeInspections: 0,
			cells: 0,
			fullResolutionFrames: 1,
		});
		expect(frameOnly).toHaveLength(1);
		expect(frameOnly[0]).toMatch(/inspect_frame/);
		expect(frameOnly[0]).not.toMatch(/inspect_range/);

		const rangeOnly = prematurePartialErrors(partial, canonical, {
			rangeInspections: 2,
			cells: 48,
			fullResolutionFrames: 0,
		});
		expect(rangeOnly).toHaveLength(1);
		expect(rangeOnly[0]).toMatch(/inspect_range/);
		expect(rangeOnly[0]).not.toMatch(/inspect_frame/);

		expect(
			prematurePartialErrors(partial, canonical, {
				rangeInspections: 0,
				cells: 0,
				fullResolutionFrames: 0,
			}),
		).toEqual([]);
	});

	it("updates the canonical mixed guard after either obligation is cleared and ignores overflow for spendability", () => {
		const onlyRange = computeUncoveredSegments(mixedIsolatedStatus({ spanUncovered: true, peakUnread: false }));
		expect(
			prematurePartialErrors(partial, onlyRange, {
				rangeInspections: 1,
				cells: 24,
				fullResolutionFrames: 0,
			}),
		).toHaveLength(1);

		const onlyPeak = computeUncoveredSegments(mixedIsolatedStatus({ spanUncovered: false, peakUnread: true }));
		expect(
			prematurePartialErrors(partial, onlyPeak, {
				rangeInspections: 0,
				cells: 0,
				fullResolutionFrames: 1,
			}),
		).toHaveLength(1);

		const withOverflow = computeUncoveredSegments(
			mixedIsolatedStatus({ spanUncovered: true, peakUnread: true, overflow: true }),
		);
		expect(
			prematurePartialErrors(partial, withOverflow, {
				rangeInspections: 0,
				cells: 0,
				fullResolutionFrames: 0,
			}),
		).toEqual([]);
	});

	it("reports mixed range and peak obligations by their independently spendable resources", () => {
		const peak = {
			startMs: 43867,
			endMs: 44000,
			reason: "isolated transient peak needing a full-resolution read",
			requiredTool: "inspect_frame" as const,
			frameIds: ["v0_f000000660_p000044000_abcdef"],
		};
		const both = prematurePartialErrors(partial, [twoGaps[0]!, peak], {
			rangeInspections: 3,
			cells: 100,
			fullResolutionFrames: 1,
		});
		expect(both).toHaveLength(2);
		expect(both[0]).toMatch(/inspect_range/);
		expect(both[1]).toMatch(/inspect_frame/);

		// If only one category is spendable, only that actionable repair is emitted.
		const frameOnly = prematurePartialErrors(partial, [twoGaps[0]!, peak], {
			rangeInspections: 0,
			cells: 0,
			fullResolutionFrames: 1,
		});
		expect(frameOnly).toHaveLength(1);
		expect(frameOnly[0]).toMatch(/inspect_frame/);

		expect(
			prematurePartialErrors(partial, [twoGaps[0]!, peak], {
				rangeInspections: 0,
				cells: 0,
				fullResolutionFrames: 0,
			}),
		).toEqual([]);
	});

	it("rejects stale partial status after the reviewer has completed every obligation", () => {
		const errors = prematurePartialErrors(partial, [], {
			rangeInspections: 60,
			cells: 1800,
			fullResolutionFrames: 20,
		});
		expect(errors).toEqual([
			'status is "partial" but deterministic coverage is complete; submit status "complete" instead',
		]);
	});

	it("never fires for a complete submission", () => {
		expect(
			prematurePartialErrors(payload({ status: "complete" }), twoGaps, {
				rangeInspections: 60,
				cells: 1800,
				fullResolutionFrames: 20,
			}),
		).toEqual([]);
	});

	it("bounds the listed segments to keep the message actionable", () => {
		const many = Array.from({ length: 12 }, (_, i) => ({
			startMs: i * 6000,
			endMs: i * 6000 + 5000,
			reason: "large uninspected recording gap",
		}));
		const errors = prematurePartialErrors(payload({ status: "partial" }), many, {
			rangeInspections: 60,
			cells: 1800,
			fullResolutionFrames: 20,
		});
		expect(errors[0]).toMatch(/12 range-coverable segment/);
		expect(errors[0]).toMatch(/and 6 more/);
	});
});
