import { describe, expect, it } from "vitest";
import {
	ANALYST_PROMPT_VERSION,
	REVIEWER_PROMPT_VERSION,
	analystSystemPrompt,
	buildAnalystBriefing,
	buildRepairPrompt,
	buildReviewerBriefing,
	reviewerSystemPrompt,
} from "../../src/agent/prompts.ts";

describe("analyst prompt/protocol", () => {
	it("is explicitly versioned", () => {
		expect(ANALYST_PROMPT_VERSION).toMatch(/^analyst-v\d+$/);
	});

	it("treats visible video text as untrusted evidence, never instructions", () => {
		const prompt = analystSystemPrompt();
		expect(prompt.toLowerCase()).toContain("untrusted");
		expect(prompt.toLowerCase()).toMatch(/never .*instruction|not .*instruction|data, not/);
	});

	it("names only the constrained inspection tools and the submit tool", () => {
		const prompt = analystSystemPrompt();
		for (const name of [
			"inspect_overview",
			"inspect_range",
			"inspect_frame",
			"compare_evidence",
			"get_inspection_status",
			"submit_analysis",
		]) {
			expect(prompt).toContain(name);
		}
	});

	it("states the whole-recording completeness protocol and the single submission rule", () => {
		const prompt = analystSystemPrompt();
		expect(prompt.toLowerCase()).toContain("get_inspection_status");
		expect(prompt.toLowerCase()).toMatch(/whole recording|entire recording|whole-recording/);
		expect(prompt.toLowerCase()).toMatch(/submit_analysis/);
	});

	it("targets a concise 15-30 beat band for long recordings", () => {
		const prompt = analystSystemPrompt();
		expect(prompt).toMatch(/15\s*[-\u2013to ]+\s*30/);
		expect(prompt.toLowerCase()).toMatch(/concise/);
	});

	it("explicitly preserves the aggregate failure classes", () => {
		const prompt = analystSystemPrompt().toLowerCase();
		expect(prompt).toMatch(/contradict|revert/); // brief contradictory transients
		expect(prompt).toMatch(/loading/); // repeated loading intervals/boundaries
		expect(prompt).toMatch(/persistent|overlay|toast/); // persistent overlays
		expect(prompt).toMatch(/incremental|scroll/); // incremental/scroll updates
	});

	it("tells the analyst to inspect every mandatory window once within the budget", () => {
		const prompt = analystSystemPrompt().toLowerCase();
		expect(prompt).toMatch(/every mandatory window/);
		expect(prompt).toMatch(/once/);
	});

	it("directs tight, evidence-bounded loading boundaries (earliest/last loading frame, both edges cited)", () => {
		const prompt = analystSystemPrompt().toLowerCase();
		expect(prompt).toMatch(/loading boundaries|loading→loaded|loading -> loaded|loading transition/);
		expect(prompt).toMatch(/earliest/);
		expect(prompt).toMatch(/last frame|last frame that/);
		expect(prompt).toMatch(/not the adjacent|not the loaded|not extend/);
		expect(prompt).toMatch(/both edges|start edge.*end edge|boundary evidence/);
	});

	it("requires a full-resolution read + literal-text transcription of each isolated-transient peak", () => {
		const prompt = analystSystemPrompt().toLowerCase();
		expect(prompt).toMatch(/isolated transient/);
		expect(prompt).toMatch(/inspect_frame/);
		expect(prompt).toMatch(/full[- ]resolution/);
		expect(prompt).toMatch(/transcribe/);
		expect(prompt).toMatch(/illegible/);
		expect(prompt).toMatch(/dense .*not|not .*enough|does not satisfy|not sufficient/);
	});

	it("bounds user report guidance by the fixed inspection and evidence rules", () => {
		const prompt = analystSystemPrompt().toLowerCase();
		expect(prompt).toMatch(/user.*guidance/);
		expect(prompt).toMatch(/never overrides|required inspection/);
	});

	it("calibrates a resolved loading/spinner as an informational observation, not a warning/failure", () => {
		const prompt = analystSystemPrompt().toLowerCase();
		expect(prompt).toMatch(/resolves?|resolved/);
		expect(prompt).toMatch(/informational|info\b|not a (failure|warning)|performance observation/);
		expect(prompt).toMatch(/unresolved|still (loading|spinning)|never resolves|end of the recording/);
	});
});

describe("reviewer prompt/protocol", () => {
	it("is explicitly versioned", () => {
		expect(REVIEWER_PROMPT_VERSION).toMatch(/^reviewer-v\d+$/);
	});

	it("requires completing a partial draft when budget remains", () => {
		const prompt = reviewerSystemPrompt().toLowerCase();
		expect(prompt).toMatch(/partial/);
		expect(prompt).toMatch(/replace/);
		expect(prompt).toMatch(/uninspected|uncovered/);
	});

	it("checks the required anomaly classes and reused evidence", () => {
		const prompt = reviewerSystemPrompt().toLowerCase();
		expect(prompt).toMatch(/contradictory-state/);
		expect(prompt).toMatch(/incremental-render/);
		expect(prompt).toMatch(/representative/);
	});

	it("rejects/replaces loading intervals lacking bounded edge evidence", () => {
		const prompt = reviewerSystemPrompt().toLowerCase();
		expect(prompt).toMatch(/loading/);
		expect(prompt).toMatch(/edge evidence|both edges|bounded/);
		expect(prompt).toMatch(/reject|replace/);
		expect(prompt).toMatch(/loaded screen|not the adjacent|extends into/);
	});

	it("must not replace a no-failure report merely to elevate a RESOLVED spinner to a warning", () => {
		const prompt = reviewerSystemPrompt().toLowerCase();
		expect(prompt).toMatch(/resolves?|resolved/);
		expect(prompt).toMatch(/must not replace|do not replace|not .*merely/);
		expect(prompt).toMatch(/no[- ]failure|no visible failure|informational|not a (failure|warning)/);
	});

	it("verifies isolated-transient peaks were read at full resolution and transcribed", () => {
		const prompt = reviewerSystemPrompt().toLowerCase();
		expect(prompt).toMatch(/isolated transient/);
		expect(prompt).toMatch(/full[- ]resolution|inspect_frame/);
		expect(prompt).toMatch(/transcrib/);
	});
});

describe("buildAnalystBriefing", () => {
	it("includes source facts, candidate windows and mandatory windows", () => {
		const briefing = buildAnalystBriefing({
			source: { basename: "clip.mp4", durationMs: 33463, width: 720, height: 1560, averageFps: 23.4 },
			candidateSummary: [{ kind: "boundary", startMs: 1000, endMs: 1100, score: 1000, representativeOrdinal: 24 }],
			mandatoryWindows: [{ startMs: 1000, endMs: 1100, candidateCount: 1, kinds: ["boundary"] }],
			budgets: { rangeInspections: 12, fullResolutionFrames: 12, cells: 250 },
		});
		expect(briefing).toContain("clip.mp4");
		expect(briefing).toContain("33463");
		expect(briefing).toContain("boundary");
		expect(briefing).toMatch(/mandatory/i);
		expect(briefing).toContain("1000-1100ms");
	});

	it("includes user report guidance verbatim", () => {
		const briefing = buildAnalystBriefing({
			source: { basename: "clip.mp4", durationMs: 1000, width: 720, height: 1560, averageFps: 24 },
			candidateSummary: [],
			mandatoryWindows: [],
			budgets: { rangeInspections: 12, fullResolutionFrames: 12, cells: 250 },
			prompt: "Focus on the button click and page load.",
		});
		expect(briefing).toContain("User report guidance");
		expect(briefing).toContain("Focus on the button click and page load.");
	});

	it("surfaces brief transient candidate clusters for high-density inspection", () => {
		const briefing = buildAnalystBriefing({
			source: { basename: "clip.mp4", durationMs: 128640, width: 500, height: 1080, averageFps: 14.7 },
			candidateSummary: [],
			mandatoryWindows: [],
			transientWindows: [{ startMs: 57097, endMs: 57935, candidateCount: 3, kinds: ["transient"] }],
			budgets: { rangeInspections: 12, fullResolutionFrames: 12, cells: 250 },
		});
		expect(briefing.toLowerCase()).toMatch(/transient/);
		expect(briefing).toContain("57097-57935ms");
		expect(briefing.toLowerCase()).toMatch(/high density|samples>=12/);
	});
});

describe("buildReviewerBriefing", () => {
	it("gives the independent reviewer the same user report guidance", () => {
		const briefing = buildReviewerBriefing({
			source: { basename: "clip.mp4", durationMs: 1000, width: 720, height: 1560, averageFps: 24 },
			candidateSummary: [],
			mandatoryWindows: [],
			budgets: { rangeInspections: 6, fullResolutionFrames: 6, cells: 100 },
			draftJson: "{}",
			prompt: "Be concise; just give an overview.",
		});
		expect(briefing).toContain("User report guidance");
		expect(briefing).toContain("Be concise; just give an overview.");
	});
});

describe("buildRepairPrompt", () => {
	it("lists the validator errors and forbids a second failure", () => {
		const repair = buildRepairPrompt(["beats[0] cites unknown frame", "coverage inconsistent"]);
		expect(repair).toContain("beats[0] cites unknown frame");
		expect(repair).toContain("coverage inconsistent");
		expect(repair.toLowerCase()).toContain("submit_analysis");
	});
});
