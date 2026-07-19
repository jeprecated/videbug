import { describe, expect, it } from "vitest";
import {
	type InspectionProgressEvent,
	estimateInitialPlan,
	formatAllowanceNotice,
	formatArtifactsKeptProgress,
	formatBusyWarning,
	formatCandidateBreakdown,
	formatClock,
	formatInspectionPlan,
	formatInspectionProgress,
} from "../../src/app/inspection-progress.ts";
import type { InspectionStatus } from "../../src/evidence/inspection-context.ts";

function budgets(overrides: Partial<Record<string, { used: number; limit: number; remaining: number }>> = {}) {
	const base = {
		rangeInspections: { used: 0, limit: 12, remaining: 12 },
		overviewInspections: { used: 0, limit: 4, remaining: 4 },
		cells: { used: 0, limit: 250, remaining: 250 },
		fullResolutionFrames: { used: 0, limit: 12, remaining: 12 },
		comparisons: { used: 0, limit: 8, remaining: 8 },
	};
	return { ...base, ...overrides } as unknown as InspectionStatus["budgets"];
}

function mkStatus(overrides: Partial<InspectionStatus> = {}): InspectionStatus {
	return {
		budgets: budgets(),
		registeredFrames: 0,
		inspectedRanges: [],
		uninspectedCandidates: [],
		mandatoryWindows: [],
		largeGaps: [],
		...overrides,
	} as InspectionStatus;
}

function windows(covered: number, total: number): InspectionStatus["mandatoryWindows"] {
	const out: InspectionStatus["mandatoryWindows"] = [];
	for (let i = 0; i < total; i++) {
		out.push({
			startMs: i * 1000,
			endMs: i * 1000 + 500,
			candidateCount: 1,
			kinds: ["boundary"],
			uninspected: i >= covered,
			uncoveredSubsegments: [],
		});
	}
	return out;
}

describe("formatClock", () => {
	it("formats milliseconds as MM:SS.mmm without rounding up", () => {
		expect(formatClock(0)).toBe("00:00.000");
		expect(formatClock(500)).toBe("00:00.500");
		expect(formatClock(72097)).toBe("01:12.097");
		expect(formatClock(258228)).toBe("04:18.228");
	});

	it("clamps negatives to zero", () => {
		expect(formatClock(-10)).toBe("00:00.000");
	});
});

describe("formatCandidateBreakdown", () => {
	it("lists each kind and omits the isolated clause when there are none", () => {
		expect(formatCandidateBreakdown({ boundary: 120, stable: 40, localAnimation: 14, transient: 5 }, 0)).toBe(
			"candidates by kind: 120 boundary, 40 stable, 14 local-animation, 5 transient",
		);
	});

	it("appends a pluralized isolated-transient count", () => {
		expect(formatCandidateBreakdown({ boundary: 1, stable: 2, localAnimation: 3, transient: 4 }, 1)).toBe(
			"candidates by kind: 1 boundary, 2 stable, 3 local-animation, 4 transient; 1 isolated transient",
		);
		expect(formatCandidateBreakdown({ boundary: 1, stable: 2, localAnimation: 3, transient: 4 }, 3)).toBe(
			"candidates by kind: 1 boundary, 2 stable, 3 local-animation, 4 transient; 3 isolated transients",
		);
	});
});

describe("formatInspectionPlan", () => {
	it("summarizes the analyst plan with dense/isolated obligations and budget", () => {
		expect(
			formatInspectionPlan({
				role: "analyst",
				mandatoryWindows: 9,
				denseWindows: 3,
				isolatedWindows: 1,
				isolatedPeaks: 2,
				rangeInspections: 12,
				cells: 250,
				fullResolutionFrames: 12,
			}),
		).toBe(
			"analyst plan: 9 mandatory window(s) to cover (3 dense, 1 isolated / 2 peak read(s)); allowance 12 range · 250 cells · 12 full-res; overview is navigation, not coverage",
		);
	});

	it("labels the reviewer plan with its own independent ledger", () => {
		expect(
			formatInspectionPlan({
				role: "reviewer",
				mandatoryWindows: 5,
				denseWindows: 2,
				isolatedWindows: 0,
				isolatedPeaks: 0,
				rangeInspections: 6,
				cells: 125,
				fullResolutionFrames: 6,
			}),
		).toBe(
			"independent reviewer plan: 5 mandatory window(s) to cover (2 dense, 0 isolated); allowance 6 range · 125 cells · 6 full-res; own independent ledger; overview is navigation, not coverage",
		);
	});
});

describe("estimateInitialPlan", () => {
	it("uses the actual context mandatory-window count, including focus windows", () => {
		expect(estimateInitialPlan(8)).toEqual({ plannedInspections: 9, plannedCellEstimate: 144 });
		expect(estimateInitialPlan(25, 5)).toEqual({ plannedInspections: 26, plannedCellEstimate: 353 });
	});
});

describe("formatAllowanceNotice", () => {
	it("separates the worst-case ceiling from the initial planned work (auto-scaled)", () => {
		expect(
			formatAllowanceNotice({
				role: "analyst",
				auto: true,
				rangeInspections: 95,
				cells: 2931,
				fullResolutionFrames: 30,
				mandatoryWindows: 25,
				isolatedPeaks: 8,
				maxChronologyGaps: 52,
				plannedInspections: 23,
				plannedCellEstimate: 312,
			}),
		).toBe(
			"analyst allowance (auto-scaled): ceiling 95 range · 2931 cells · 30 full-res (worst-case cap, not work sent); initial plan ~23 inspection(s) / ~312 cells; 25 actual mandatory window(s) + up to 52 gap close(s) + 8 isolated peak read(s)",
		);
	});

	it("labels the frozen evaluation plan distinctly and marks the ceiling as not work sent", () => {
		const notice = formatAllowanceNotice({
			role: "reviewer",
			auto: false,
			rangeInspections: 6,
			cells: 125,
			fullResolutionFrames: 6,
			mandatoryWindows: 7,
			isolatedPeaks: 8,
			maxChronologyGaps: 52,
			plannedInspections: 6,
			plannedCellEstimate: 108,
		});
		expect(notice).toMatch(/reviewer allowance \(frozen evaluation\): ceiling 6 range/);
		expect(notice).toMatch(/not work sent/);
		expect(notice).toMatch(/initial plan ~6 inspection\(s\) \/ ~108 cells/);
	});
});

describe("formatBusyWarning", () => {
	it("frames the ceiling as a worst-case cap, not a batch sent up front — no percentage", () => {
		const warning = formatBusyWarning(258228, 2931, 133);
		expect(warning).toMatch(/long\/busy recording \(04:18\.228\)/);
		expect(warning).toMatch(/up to ~2931 frames/);
		expect(warning).toMatch(/~133 images/);
		expect(warning).toMatch(/worst-case cap, not a batch sent up front/);
		expect(warning).toMatch(/incrementally/);
		expect(warning).not.toMatch(/%/);
	});
});

describe("privacy-safe phase progress", () => {
	it("never accepts or renders the requested artifacts path", () => {
		const hostile = "/home/user/.config/provider/token=super-secret/artifacts";
		const line = formatArtifactsKeptProgress();
		expect(line).toBe("kept evidence and run manifest in the requested artifacts directory");
		expect(line).not.toContain(hostile);
		expect(line).not.toContain("super-secret");
	});
});

describe("formatInspectionProgress", () => {
	it("overview: cells, coverage, and registered frames; explicit navigation-not-coverage", () => {
		const event: InspectionProgressEvent = {
			tool: "inspect_overview",
			details: { accepted: true, cells: 42, sheetWidth: 100, sheetHeight: 100 },
			status: mkStatus({
				registeredFrames: 42,
				budgets: budgets({ cells: { used: 42, limit: 250, remaining: 208 } }),
				mandatoryWindows: windows(0, 9),
			}),
		};
		expect(formatInspectionProgress(event)).toBe(
			"overview: 42 cell(s) sampled; mandatory 0/9 covered; cells 42/250; 42 frame(s) registered (navigation, not coverage)",
		);
	});

	it("overview rejection emits a fixed classification, never a backend payload", () => {
		const event: InspectionProgressEvent = {
			tool: "inspect_overview",
			details: { accepted: false, cells: 0, message: "secret-visible-text /home/user/token" },
			status: mkStatus(),
		};
		expect(formatInspectionProgress(event)).toBe("overview rejected: inspection unavailable");
	});

	it("range: formatted clock span, reason, frames, coverage, budgets, gaps", () => {
		const event: InspectionProgressEvent = {
			tool: "inspect_range",
			request: { startMs: 12000, endMs: 23000, samples: 18, reason: "chronology" },
			details: { accepted: true, samples: 18, resolvedStartMs: 12000, resolvedEndMs: 23000 },
			status: mkStatus({
				budgets: budgets({
					rangeInspections: { used: 3, limit: 12, remaining: 9 },
					cells: { used: 96, limit: 250, remaining: 154 },
				}),
				mandatoryWindows: windows(3, 9),
				largeGaps: [
					{ startMs: 0, endMs: 6000 },
					{ startMs: 30000, endMs: 40000 },
				],
			}),
		};
		expect(formatInspectionProgress(event)).toBe(
			"range 00:12.000–00:23.000 (chronology): 18 frame(s); mandatory 3/9 covered; range calls 3/12; cells 96/250; 2 large gap(s) remain",
		);
	});

	it("range rejection reports only safe range metadata and a fixed classification", () => {
		const event: InspectionProgressEvent = {
			tool: "inspect_range",
			request: { startMs: 57000, endMs: 57500, samples: 12, reason: "transient" },
			details: { accepted: false, samples: 0, message: "secret-visible-text /home/user/token" },
			status: mkStatus(),
		};
		const line = formatInspectionProgress(event);
		expect(line).toBe("range 00:57.000–00:57.500 (transient) rejected: request not admitted");
		expect(line).not.toContain("secret-visible-text");
		expect(line).not.toContain("/home/user/token");
	});

	it("frame: exact registered PTS (not visible text) and remaining peak obligations", () => {
		const event: InspectionProgressEvent = {
			tool: "inspect_frame",
			request: { frameId: "f_00042" },
			ptsMs: 57097,
			details: { frameId: "f_00042", width: 500, height: 1080, mimeType: "image/png" },
			status: mkStatus({
				budgets: budgets({ fullResolutionFrames: { used: 1, limit: 12, remaining: 11 } }),
				mandatoryWindows: [
					{
						startMs: 57000,
						endMs: 58000,
						candidateCount: 1,
						kinds: ["transient"],
						uninspected: true,
						uncoveredSubsegments: [],
						peakOrdinals: [1462],
						peakOrdinalsNeedingFullRes: [1462],
					},
				],
			}),
		};
		expect(formatInspectionProgress(event)).toBe("frame f_00042 @ 00:57.097: full-res 1/12; 1 peak read(s) remaining");
	});

	it("frame: omits the peak clause when no obligations remain and omits time when unknown", () => {
		const event: InspectionProgressEvent = {
			tool: "inspect_frame",
			request: { frameId: "f_x" },
			details: { frameId: "f_x", width: 1, height: 1, mimeType: "image/png" },
			status: mkStatus({ budgets: budgets({ fullResolutionFrames: { used: 2, limit: 12, remaining: 10 } }) }),
		};
		expect(formatInspectionProgress(event)).toBe("frame f_x: full-res 2/12");
	});

	it("frame rejection never carries or renders a hostile model-controlled frame id or raw error", () => {
		const event: InspectionProgressEvent = {
			tool: "inspect_frame",
			rejection: "unregistered-frame-id",
			status: mkStatus(),
		};
		const line = formatInspectionProgress(event);
		expect(line).toBe("frame request rejected: unregistered frame id");
		expect(JSON.stringify(event)).not.toContain("AWS_SECRET_ACCESS_KEY");
		expect(line).not.toContain("/home/user/.ssh/id_ed25519");
	});

	it("frame allowance rejection uses a fixed safe classification", () => {
		const event: InspectionProgressEvent = {
			tool: "inspect_frame",
			rejection: "allowance-unavailable",
			status: mkStatus(),
		};
		expect(formatInspectionProgress(event)).toBe("frame request rejected: full-resolution allowance unavailable");
	});

	it("compare: frame count and comparison budget", () => {
		const event: InspectionProgressEvent = {
			tool: "compare_evidence",
			request: { frameIds: 2 },
			details: { accepted: true, pairs: 1 },
			status: mkStatus({ budgets: budgets({ comparisons: { used: 1, limit: 8, remaining: 7 } }) }),
		};
		expect(formatInspectionProgress(event)).toBe("compare 2 frame(s): comparisons 1/8");
	});

	it("compare rejection reports count and a fixed classification only", () => {
		const event: InspectionProgressEvent = {
			tool: "compare_evidence",
			request: { frameIds: 2 },
			details: { accepted: false, pairs: 0, message: "AWS_SECRET_ACCESS_KEY=/home/user/token" },
			status: mkStatus(),
		};
		const line = formatInspectionProgress(event);
		expect(line).toBe("compare 2 frame(s) rejected: evidence unavailable");
		expect(line).not.toContain("AWS_SECRET_ACCESS_KEY");
	});

	it("status: coverage, uninspected candidates, gaps, and all budget usage", () => {
		const event: InspectionProgressEvent = {
			tool: "get_inspection_status",
			status: mkStatus({
				budgets: budgets({
					rangeInspections: { used: 6, limit: 12, remaining: 6 },
					cells: { used: 150, limit: 250, remaining: 100 },
					fullResolutionFrames: { used: 2, limit: 12, remaining: 10 },
				}),
				mandatoryWindows: windows(5, 9),
				uninspectedCandidates: [
					{ kind: "boundary", startMs: 0, endMs: 100, score: 1, representativeOrdinal: 0 },
					{ kind: "transient", startMs: 1, endMs: 2, score: 2, representativeOrdinal: 1 },
					{ kind: "stable", startMs: 3, endMs: 4, score: 3, representativeOrdinal: 2 },
					{ kind: "boundary", startMs: 5, endMs: 6, score: 4, representativeOrdinal: 3 },
				],
				largeGaps: [{ startMs: 0, endMs: 6000 }],
			}),
		};
		expect(formatInspectionProgress(event)).toBe(
			"status: mandatory 5/9 covered; 4 uninspected candidate(s); 1 large gap(s); range 6/12; cells 150/250; full-res 2/12; compare 0/8",
		);
	});
});
