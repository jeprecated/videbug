import { describe, expect, it } from "vitest";
import type { AnalysisProvenance, AnalysisSource, SubmitAnalysisPayload } from "../../src/contracts/analysis-v1.ts";
import { composeAnalysisResult } from "../../src/contracts/analysis-v1.ts";
import {
	type EvidenceRegistryView,
	evidenceRegistryFromEntries,
	validateAnalysisResult,
} from "../../src/contracts/validation.ts";

const source: AnalysisSource = {
	basename: "recording.mp4",
	sha256: "a".repeat(64),
	durationMs: 2000,
	width: 1080,
	height: 1920,
	streamIndex: 0,
	averageFps: 30,
};

const provenance: AnalysisProvenance = {
	toolVersion: "0.0.0",
	ffmpegVersion: "8.1.1",
	analystModel: "anthropic/claude-opus-4-5",
	inspectionCalls: 3,
	inspectedCells: 40,
	fullResolutionFrames: 2,
};

const FRAME_A = "v0_f000000_p000000_aaaaaa";
const FRAME_B = "v0_f000019_p001900_bbbbbb";
const FRAME_C = "v0_f000010_p001000_cccccc";

function registry(): EvidenceRegistryView {
	return evidenceRegistryFromEntries([
		[FRAME_A, 0],
		[FRAME_B, 1900],
		[FRAME_C, 1000],
	]);
}

function goodPayload(): SubmitAnalysisPayload {
	return {
		schemaVersion: "1",
		status: "complete",
		coverage: { analyzedStartMs: 0, analyzedEndMs: 2000, uninspectedRanges: [], confidence: "high" },
		summary: { observedFailure: "clears then restores", chronology: "idle, cleared, restored" },
		beats: [
			{
				id: "B1",
				time: { startMs: 0, endMs: 1000, precisionMs: 100 },
				kind: "state",
				observation: { summary: "idle stack", visibleText: ["Waiting"], motion: "none" },
				evidence: [{ frameId: FRAME_A, ptsMs: 0, role: "representative" }],
				confidence: "high",
				inferences: [],
			},
			{
				id: "B2",
				time: { startMs: 1000, endMs: 2000, precisionMs: 100 },
				kind: "transition",
				observation: { summary: "cleared then restored", visibleText: [], motion: "global-transition" },
				transitionFromPrevious: "Session Stack cleared",
				evidence: [
					{ frameId: FRAME_C, ptsMs: 1000, role: "before" },
					{ frameId: FRAME_B, ptsMs: 1900, role: "after" },
				],
				confidence: "medium",
				inferences: [],
			},
		],
		anomalies: [
			{
				category: "contradictory-state",
				severity: "warning",
				description: "stack cleared momentarily",
				whySuspicious: "reverted without user action",
				beatIds: ["B2"],
				evidence: [{ frameId: FRAME_B, ptsMs: 1900, role: "boundary" }],
				confidence: "medium",
				uncertainties: ["cause not visible"],
			},
		],
		handoff: {
			reproductionSteps: ["open stack", "wait"],
			suggestedInvestigations: [{ statement: "inspect reload logic", kind: "action" }],
			uncertainties: ["backend not observable"],
		},
	};
}

function good() {
	return composeAnalysisResult(goodPayload(), { source, provenance });
}

describe("validateAnalysisResult", () => {
	it("accepts a fully valid, cited, in-bounds result", () => {
		const result = validateAnalysisResult(good(), { registry: registry() });
		expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
	});

	it("rejects a beat time outside the source duration", () => {
		const r = good();
		r.beats[1]!.time.endMs = 9999;
		const out = validateAnalysisResult(r, { registry: registry() });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.errors.join("\n")).toMatch(/duration|bounds|9999/i);
	});

	it("rejects beats that are out of chronological order", () => {
		const r = good();
		[r.beats[0], r.beats[1]] = [r.beats[1]!, r.beats[0]!];
		const out = validateAnalysisResult(r, { registry: registry() });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.errors.join("\n")).toMatch(/order/i);
	});

	it("rejects overlapping beats", () => {
		const r = good();
		r.beats[1]!.time.startMs = 500; // overlaps B1 [0,1000)
		const out = validateAnalysisResult(r, { registry: registry() });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.errors.join("\n")).toMatch(/overlap/i);
	});

	it("rejects a zero-duration transient with zero precision", () => {
		const r = good();
		r.beats[1]!.time = { startMs: 1500, endMs: 1500, precisionMs: 0 };
		const out = validateAnalysisResult(r, { registry: registry() });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.errors.join("\n")).toMatch(/precision/i);
	});

	it("rejects a citation to a frame id absent from the registry", () => {
		const r = good();
		r.beats[0]!.evidence[0]!.frameId = "v0_f999999_p000000_zzzzzz";
		const out = validateAnalysisResult(r, { registry: registry() });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.errors.join("\n")).toMatch(/registry|unknown|not.*evidence/i);
	});

	it("rejects a citation whose ptsMs does not exactly match the registry", () => {
		const r = good();
		r.beats[0]!.evidence[0]!.ptsMs = 1; // registry says 0
		const out = validateAnalysisResult(r, { registry: registry() });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.errors.join("\n")).toMatch(/pts/i);
	});

	it("rejects transition evidence where before follows after", () => {
		const r = good();
		r.beats[1]!.evidence = [
			{ frameId: FRAME_B, ptsMs: 1900, role: "before" },
			{ frameId: FRAME_C, ptsMs: 1000, role: "after" },
		];
		const out = validateAnalysisResult(r, { registry: registry() });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.errors.join("\n")).toMatch(/before|after|order/i);
	});

	it("rejects an anomaly referencing an unknown beat id", () => {
		const r = good();
		r.anomalies[0]!.beatIds = ["B99"];
		const out = validateAnalysisResult(r, { registry: registry() });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.errors.join("\n")).toMatch(/B99/);
	});

	it("rejects a complete status that still has uninspected ranges", () => {
		const r = good();
		r.coverage.uninspectedRanges = [{ startMs: 100, endMs: 200 }];
		const out = validateAnalysisResult(r, { registry: registry() });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.errors.join("\n")).toMatch(/uninspected|complete/i);
	});

	it("rejects a result whose coverage omits the final region without stating uncertainty", () => {
		const r = good();
		r.coverage.analyzedEndMs = 1000;
		r.handoff.uncertainties = [];
		const out = validateAnalysisResult(r, { registry: registry() });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.errors.join("\n")).toMatch(/final|end|region/i);
	});

	it("accepts reaching within one frame interval of the end (tail tolerance, no invented precision)", () => {
		// The last source frame's PTS is a frame-interval short of the container
		// duration; reaching it represents the final region without the model having
		// to fabricate an exact end or an uncertainty about a sub-frame tail.
		const r = good();
		r.coverage.analyzedEndMs = r.source.durationMs - 33; // ~one 30fps frame short
		r.handoff.uncertainties = [];
		const out = validateAnalysisResult(r, { registry: registry(), tailToleranceMs: 34 });
		expect(out.ok).toBe(true);
	});

	it("still rejects an end far short of duration even with a small tail tolerance", () => {
		const r = good();
		r.coverage.analyzedEndMs = r.source.durationMs - 500;
		r.handoff.uncertainties = [];
		const out = validateAnalysisResult(r, { registry: registry(), tailToleranceMs: 34 });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.errors.join("\n")).toMatch(/final|end|region/i);
	});

	it("requires a sustained local-animation (loading) beat to cite evidence near BOTH edges", () => {
		const r = good();
		// Turn B1 [0,1000] into a sustained loading spinner with ONLY a start-edge cite.
		r.beats[0]!.observation.motion = "local-animation";
		r.beats[0]!.observation.summary = "Loading Session detail spinner";
		// evidence stays [FRAME_A @0] -> start edge only, missing the end edge.
		const out = validateAnalysisResult(r, { registry: registry(), tailToleranceMs: 34 });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.errors.join("\n")).toMatch(/END edge/i);
	});

	it("accepts a sustained local-animation beat bounded by edge evidence at both ends", () => {
		const r = good();
		r.beats[0]!.observation.motion = "local-animation";
		r.beats[0]!.observation.summary = "Loading Session detail spinner";
		r.beats[0]!.evidence = [
			{ frameId: FRAME_A, ptsMs: 0, role: "boundary" }, // start edge
			{ frameId: FRAME_C, ptsMs: 1000, role: "boundary" }, // end edge (endMs=1000)
		];
		const out = validateAnalysisResult(r, { registry: registry(), tailToleranceMs: 34 });
		expect(out.ok, out.ok ? "" : out.errors.join("\n")).toBe(true);
	});

	it("exempts a near-instant local-animation flash from the edge-evidence rule", () => {
		const r = good();
		// A very short animated flash has no distinct edges to bound.
		r.beats[0]!.time = { startMs: 0, endMs: 100, precisionMs: 50 };
		r.beats[0]!.observation.motion = "local-animation";
		r.beats[0]!.evidence = [{ frameId: FRAME_A, ptsMs: 0, role: "representative" }];
		r.beats[1]!.time.startMs = 100;
		const out = validateAnalysisResult(r, { registry: registry(), tailToleranceMs: 34 });
		expect(out.ok, out.ok ? "" : out.errors.join("\n")).toBe(true);
	});

	it("rejects duplicate beat ids", () => {
		const r = good();
		r.beats[1]!.id = "B1";
		const out = validateAnalysisResult(r, { registry: registry() });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.errors.join("\n")).toMatch(/duplicate|B1/i);
	});

	it("passes structural schema failures through as errors, not exceptions", () => {
		const out = validateAnalysisResult({ nonsense: true }, { registry: registry() });
		expect(out.ok).toBe(false);
	});
});

describe("evidenceRegistryFromEntries", () => {
	it("resolves known frame ids and rejects unknown ones", () => {
		const reg = evidenceRegistryFromEntries([[FRAME_A, 0]]);
		expect(reg.resolve(FRAME_A)).toEqual({ ptsMs: 0 });
		expect(reg.resolve("missing")).toBeUndefined();
	});
});
