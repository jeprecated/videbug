import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImage } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEvidenceEngine } from "../../src/app/evidence-engine.ts";
import { createInspectionContext } from "../../src/evidence/inspection-context.ts";
import { STATIC_FIXTURE, ensureFixtures } from "../helpers/fixtures.ts";

let workdir: string;
let engine: Awaited<ReturnType<typeof runEvidenceEngine>>;

const DEFAULT_TEST_BUDGETS = {
	rangeInspections: 12,
	overviewInspections: 4,
	cells: 250,
	fullResolutionFrames: 12,
	comparisons: 8,
	sheetMaxDimension: 4096,
	sheetMaxBytes: 5 * 1024 * 1024,
};

beforeAll(async () => {
	await ensureFixtures();
	engine = await runEvidenceEngine(STATIC_FIXTURE.path);
	workdir = mkdtempSync(join(tmpdir(), "vtd-ctx-test-"));
});
afterAll(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe("createInspectionContext (integration over the M2 engine)", () => {
	it("produces an overview sheet whose manifest PTS matches the source catalog", async () => {
		const ctx = createInspectionContext(engine, { videoPath: STATIC_FIXTURE.path, workspaceDir: workdir });
		const overview = await ctx.runOverview();
		expect(overview.ok).toBe(true);
		if (!overview.ok) return;

		// The sheet is a decodable PNG.
		const decoded = await loadImage(Buffer.from(overview.sheet.data, "base64"));
		expect(decoded.width).toBe(overview.sheet.width);

		// Every manifest entry's frame ID is registered and its PTS matches the catalog.
		for (const entry of overview.manifest) {
			const record = ctx.registry.get(entry.frameId);
			expect(record).toBeDefined();
			expect(record?.ptsMs).toBe(entry.ptsMs);
			const catalogFrame = engine.catalog.frames[record!.ordinal];
			expect(Math.round(catalogFrame!.ptsUs / 1000)).toBe(entry.ptsMs);
		}
		// First and final source frames are represented.
		expect(overview.manifest[0]!.ptsMs).toBe(0);
	});

	it("resolves a targeted range to explicit source ordinals and marks it inspected", async () => {
		const ctx = createInspectionContext(engine, { videoPath: STATIC_FIXTURE.path, workspaceDir: workdir });
		const range = await ctx.runRange({ startMs: 1800, endMs: 2200, samples: 5, reason: "boundary" });
		expect(range.ok).toBe(true);
		if (!range.ok) return;
		expect(range.manifest.length).toBeGreaterThan(0);
		for (const entry of range.manifest) {
			expect(entry.ptsMs).toBeGreaterThanOrEqual(1800);
			expect(entry.ptsMs).toBeLessThanOrEqual(2200);
			expect(ctx.registry.has(entry.frameId)).toBe(true);
		}
		expect(ctx.registry.inspectedRanges().some((r) => r.reason === "boundary")).toBe(true);
	});

	it("admits a one-cell targeted range when exactly one cell remains", async () => {
		const ctx = createInspectionContext(engine, {
			videoPath: STATIC_FIXTURE.path,
			workspaceDir: workdir,
			budgets: { ...DEFAULT_TEST_BUDGETS, cells: 1 },
		});
		const range = await ctx.runRange({ startMs: 0, endMs: 50, samples: 1, reason: "boundary" });
		expect(range.ok).toBe(true);
		if (!range.ok) return;
		expect(range.manifest).toHaveLength(1);
		expect(ctx.status().budgets.cells).toMatchObject({ used: 1, remaining: 0 });
	});

	it("enforces the duplicate/density rule on repeated range requests", async () => {
		const ctx = createInspectionContext(engine, { videoPath: STATIC_FIXTURE.path, workspaceDir: workdir });
		const first = await ctx.runRange({ startMs: 0, endMs: 1000, samples: 6, reason: "chronology" });
		expect(first.ok).toBe(true);
		// Same window, same reason, equal-or-lower density -> rejected.
		const repeat = await ctx.runRange({ startMs: 0, endMs: 1000, samples: 3, reason: "chronology" });
		expect(repeat.ok).toBe(false);
		// Different reason -> allowed.
		const differentReason = await ctx.runRange({ startMs: 0, endMs: 1000, samples: 3, reason: "text" });
		expect(differentReason.ok).toBe(true);
	});

	it("lets a broad same-reason gap closure extend past a high-density endpoint point", async () => {
		const ctx = createInspectionContext(engine, {
			videoPath: STATIC_FIXTURE.path,
			workspaceDir: workdir,
			largeGapMs: 400,
		});
		// A narrow request can resolve to one source frame and is therefore recorded as
		// a zero-span, artificial 1000 samples/s point — the exact poison shape from
		// video 11's 50.522s and 114.669s gap endpoints.
		const point = await ctx.runRange({ startMs: 0, endMs: 50, samples: 1, reason: "chronology" });
		expect(point.ok).toBe(true);
		if (!point.ok) return;
		expect(point.resolvedStartMs).toBe(point.resolvedEndMs);

		const broad = await ctx.runRange({ startMs: 0, endMs: 1000, samples: 12, reason: "chronology" });
		expect(broad.ok).toBe(true);
		if (!broad.ok) return;
		expect(broad.resolvedEndMs).toBeGreaterThan(point.resolvedEndMs);
		expect(ctx.status().budgets.rangeInspections.used).toBe(2);
	});

	it("authorizes full-resolution frames only through registered IDs", async () => {
		const ctx = createInspectionContext(engine, { videoPath: STATIC_FIXTURE.path, workspaceDir: workdir });
		const overview = await ctx.runOverview();
		expect(overview.ok).toBe(true);
		if (!overview.ok) return;
		const frameId = overview.manifest[0]!.frameId;
		const image = await ctx.loadFrame(frameId);
		expect(image.mimeType).toBe("image/png");
		expect(image.data.length).toBeGreaterThan(0);
		await expect(ctx.loadFrame("../../etc/passwd")).rejects.toThrow(/not in the evidence registry/);
	});

	it("compares registered frames and rejects unregistered IDs", async () => {
		const ctx = createInspectionContext(engine, { videoPath: STATIC_FIXTURE.path, workspaceDir: workdir });
		const overview = await ctx.runOverview();
		if (!overview.ok) throw new Error("overview failed");
		const [a, b] = [overview.manifest[0]!.frameId, overview.manifest[overview.manifest.length - 1]!.frameId];
		const result = await ctx.runCompare([a, b]);
		expect("pairs" in result && result.pairs.length).toBe(1);
		const rejected = await ctx.runCompare([a, "not-registered"]);
		expect("ok" in rejected && rejected.ok).toBe(false);
	});

	it("does not let the overview count as candidate or gap coverage (reason/density aware)", async () => {
		const ctx = createInspectionContext(engine, {
			videoPath: STATIC_FIXTURE.path,
			workspaceDir: workdir,
			largeGapMs: 400,
		});
		const before = ctx.status();
		expect(before.uninspectedCandidates.length).toBeGreaterThan(0);
		expect(before.largeGaps.length).toBeGreaterThan(0);

		const overview = await ctx.runOverview();
		expect(overview.ok).toBe(true);

		const afterOverview = ctx.status();
		// The overview IS recorded as an inspected range for provenance...
		expect(afterOverview.inspectedRanges.some((r) => r.reason === "overview")).toBe(true);
		// ...but it is a sparse full-span pass, so mandatory candidates and large gaps
		// must remain until a targeted range actually inspects them.
		expect(afterOverview.uninspectedCandidates.length).toBe(before.uninspectedCandidates.length);
		expect(afterOverview.largeGaps.length).toBeGreaterThan(0);
	});

	it("clears a mandatory candidate only after a targeted range covers it", async () => {
		const ctx = createInspectionContext(engine, {
			videoPath: STATIC_FIXTURE.path,
			workspaceDir: workdir,
			largeGapMs: 400,
		});
		await ctx.runOverview();
		const afterOverview = ctx.status();
		const target = afterOverview.uninspectedCandidates[0];
		expect(target).toBeDefined();
		if (!target) return;

		const range = await ctx.runRange({
			startMs: Math.max(0, target.startMs - 200),
			endMs: target.endMs + 200,
			samples: 6,
			reason: "boundary",
		});
		expect(range.ok).toBe(true);

		const after = ctx.status();
		const stillUninspected = after.uninspectedCandidates.some(
			(c) => c.startMs === target.startMs && c.endMs === target.endMs,
		);
		expect(stillUninspected).toBe(false);
		expect(after.uninspectedCandidates.length).toBeLessThan(afterOverview.uninspectedCandidates.length);
	});

	it("reconciles candidates into a bounded, honest set of mandatory windows", async () => {
		const ctx = createInspectionContext(engine, {
			videoPath: STATIC_FIXTURE.path,
			workspaceDir: workdir,
			budgets: { ...DEFAULT_TEST_BUDGETS, rangeInspections: 3 },
		});
		const before = ctx.status();
		// Grouped mandatory windows never exceed the range budget, so completeness is
		// achievable within budget (no need to mark overview as coverage).
		expect(before.mandatoryWindows.length).toBeGreaterThan(0);
		expect(before.mandatoryWindows.length).toBeLessThanOrEqual(3);
		expect(before.mandatoryWindows.every((w) => w.uninspected)).toBe(true);

		// The overview must NOT clear any mandatory window (sparse full-span pass).
		await ctx.runOverview();
		expect(ctx.status().mandatoryWindows.every((w) => w.uninspected)).toBe(true);

		// A targeted range covering a window's whole span clears exactly that window.
		const target = before.mandatoryWindows[0]!;
		await ctx.runRange({
			startMs: Math.max(0, target.startMs - 100),
			endMs: target.endMs + 100,
			samples: 6,
			reason: "boundary",
		});
		const after = ctx.status();
		const cleared = after.mandatoryWindows.find((w) => w.startMs === target.startMs && w.endMs === target.endMs);
		expect(cleared?.uninspected).toBe(false);
		expect(after.mandatoryWindows.filter((w) => w.uninspected).length).toBeLessThan(before.mandatoryWindows.length);
	});

	it("covers a wide mandatory window with the union of several adjacent ranges", async () => {
		const ctx = createInspectionContext(engine, {
			videoPath: STATIC_FIXTURE.path,
			workspaceDir: workdir,
			budgets: { ...DEFAULT_TEST_BUDGETS, rangeInspections: 6 },
			mandatoryMergeGapMs: 100000, // force all candidates into one wide window
		});
		const before = ctx.status();
		// The single wide SPAN window (density-gated transient focus windows are separate).
		const spanWindows = before.mandatoryWindows.filter((w) => w.minDensity === undefined);
		expect(spanWindows).toHaveLength(1);
		const window = spanWindows[0]!;
		expect(window.uninspected).toBe(true);
		const spanStatus = () =>
			ctx.status().mandatoryWindows.find((w) => w.startMs === window.startMs && w.endMs === window.endMs)!;

		// Cover the window in two overlapping halves (different reasons); neither alone
		// contains the window, but their union does.
		const mid = Math.floor((window.startMs + window.endMs) / 2);
		await ctx.runRange({ startMs: window.startMs, endMs: mid + 300, samples: 6, reason: "chronology" });
		expect(spanStatus().uninspected).toBe(true);
		await ctx.runRange({ startMs: Math.max(0, mid - 300), endMs: window.endMs, samples: 6, reason: "boundary" });
		expect(spanStatus().uninspected).toBe(false);
	});

	it("covers a wide window with two ADJACENT non-overlapping ranges (frame-interval tolerance)", async () => {
		const ctx = createInspectionContext(engine, {
			videoPath: STATIC_FIXTURE.path,
			workspaceDir: workdir,
			budgets: { ...DEFAULT_TEST_BUDGETS, rangeInspections: 6 },
			mandatoryMergeGapMs: 100000, // force all candidates into one wide window
		});
		const before = ctx.status();
		const spanWindows = before.mandatoryWindows.filter((w) => w.minDensity === undefined);
		expect(spanWindows).toHaveLength(1);
		const window = spanWindows[0]!;
		expect(window.uncoveredSubsegments.length).toBeGreaterThan(0);
		const spanStatus = () =>
			ctx.status().mandatoryWindows.find((w) => w.startMs === window.startMs && w.endMs === window.endMs)!;

		// Two ADJACENT, non-overlapping ranges meeting at the midpoint. Their sampled
		// PTS leave at most a one-frame gap, which the tolerance folds together so the
		// window is honestly covered with no sub-frame sliver flagged.
		const mid = Math.floor((window.startMs + window.endMs) / 2);
		await ctx.runRange({ startMs: window.startMs, endMs: mid, samples: 8, reason: "chronology" });
		await ctx.runRange({ startMs: mid, endMs: window.endMs, samples: 8, reason: "boundary" });
		expect(spanStatus().uninspected).toBe(false);
		expect(spanStatus().uncoveredSubsegments).toEqual([]);
	});

	it("exposes narrow transient-candidate clusters for high-density inspection", () => {
		const ctx = createInspectionContext(engine, { videoPath: STATIC_FIXTURE.path, workspaceDir: workdir });
		// transientWindows is always defined and each is a bounded, ordered window.
		expect(Array.isArray(ctx.transientWindows)).toBe(true);
		let prevEnd = -1;
		for (const w of ctx.transientWindows) {
			expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
			expect(w.startMs).toBeGreaterThanOrEqual(prevEnd);
			prevEnd = w.endMs;
		}
	});

	it("rejects a zero-width inspect_range without consuming budget", async () => {
		const ctx = createInspectionContext(engine, { videoPath: STATIC_FIXTURE.path, workspaceDir: workdir });
		const before = ctx.budgets.usage().rangeInspections.used;
		const rejected = await ctx.runRange({ startMs: 5000, endMs: 5000, samples: 1, reason: "chronology" });
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) expect(rejected.message).toMatch(/zero-width|endMs > startMs/);
		// Budget is untouched — the wasted point does not spend an inspect_range call.
		expect(ctx.budgets.usage().rangeInspections.used).toBe(before);
	});

	it("uses budget consume as the authoritative atomic gate", async () => {
		const ctx = createInspectionContext(engine, {
			videoPath: STATIC_FIXTURE.path,
			workspaceDir: workdir,
			budgets: {
				rangeInspections: 5,
				overviewInspections: 1,
				cells: 500,
				fullResolutionFrames: 1,
				comparisons: 1,
				sheetMaxDimension: 4096,
				sheetMaxBytes: 5 * 1024 * 1024,
			},
		});
		const overview = await ctx.runOverview();
		expect(overview.ok).toBe(true);
		if (!overview.ok) return;
		// consume's return is authoritative: cells were decremented by exactly the
		// number of rendered cells, not silently ignored.
		const cellsUsed = ctx.budgets.usage().cells.used;
		expect(cellsUsed).toBe(overview.manifest.length);
		expect(ctx.budgets.usage().overviewInspections.used).toBe(1);

		// A second overview is rejected by the gate and consumes NOTHING (atomic).
		const second = await ctx.runOverview();
		expect(second.ok).toBe(false);
		expect(ctx.budgets.usage().cells.used).toBe(cellsUsed);
		expect(ctx.budgets.usage().overviewInspections.used).toBe(1);
	});

	it("enforces budgets and reports coverage via status", async () => {
		const ctx = createInspectionContext(engine, {
			videoPath: STATIC_FIXTURE.path,
			workspaceDir: workdir,
			budgets: {
				rangeInspections: 1,
				overviewInspections: 1,
				cells: 200,
				fullResolutionFrames: 1,
				comparisons: 1,
				sheetMaxDimension: 4096,
				sheetMaxBytes: 5 * 1024 * 1024,
			},
		});
		await ctx.runOverview();
		const first = await ctx.runRange({ startMs: 0, endMs: 500, samples: 3, reason: "chronology" });
		expect(first.ok).toBe(true);
		const exhausted = await ctx.runRange({ startMs: 2000, endMs: 2500, samples: 3, reason: "chronology" });
		expect(exhausted.ok).toBe(false);
		if (!exhausted.ok) expect(exhausted.message).toContain("rangeInspections");

		const status = ctx.status();
		expect(status.budgets.rangeInspections.remaining).toBe(0);
		expect(status.registeredFrames).toBeGreaterThan(0);
		expect(status.inspectedRanges.length).toBeGreaterThanOrEqual(2);
	});

	it("gives an isolated transient its own focus window and fails closed until its peak has a full-resolution read", async () => {
		// Inject one isolated transient at a real black-region ordinal (5 -> 500ms @10fps).
		const withIsolated = {
			...engine,
			isolatedTransients: [
				{
					startOrdinal: 5,
					endOrdinal: 5,
					startPtsUs: 500_000,
					endPtsUs: 500_000,
					peakOrdinal: 5,
					peakPtsUs: 500_000,
					peakRatio: 0.4,
				},
			],
		};
		const ctx = createInspectionContext(withIsolated, {
			videoPath: STATIC_FIXTURE.path,
			workspaceDir: workdir,
			mandatoryMaxGroups: 10,
		});
		// The isolated transient has its OWN mandatory focus window carrying its peak.
		const isolated = ctx.mandatoryWindows.find((w) => w.peakOrdinals?.includes(5));
		expect(isolated).toBeDefined();
		expect(isolated!.minDensity).toBeGreaterThan(0);
		expect(ctx.isolatedFocusWindows.length).toBe(1);
		// Total mandatory groups stay within the range-inspection budget.
		expect(ctx.mandatoryWindows.length).toBeLessThanOrEqual(ctx.budgets.budgets.rangeInspections);

		// The overview registers the protected peak frame (ordinal 5).
		const overview = await ctx.runOverview();
		expect(overview.ok).toBe(true);
		const peakRecord = ctx.registry.getByOrdinal(5);
		expect(peakRecord).toBeDefined();

		// A dense range covers the window span, but the peak has NOT been full-res read:
		// the focus window stays UNINSPECTED (fail closed on the full-resolution read).
		await ctx.runRange({ startMs: 400, endMs: 600, samples: 12, reason: "transient" });
		const before = ctx.status();
		const wBefore = before.mandatoryWindows.find((w) => w.peakOrdinals?.includes(5));
		expect(wBefore?.peakOrdinalsNeedingFullRes).toEqual([5]);
		expect(wBefore?.uninspected).toBe(true);

		// Read the peak at full resolution -> its gate clears.
		await ctx.loadFrame(peakRecord!.id);
		const after = ctx.status();
		const wAfter = after.mandatoryWindows.find((w) => w.peakOrdinals?.includes(5));
		expect(wAfter?.peakOrdinalsNeedingFullRes).toEqual([]);
		expect(after.registeredFrames).toBeGreaterThan(0);
	});

	it("overflows isolated transients beyond the focus budget into an honest-partial signal", () => {
		const withIsolated = {
			...engine,
			isolatedTransients: [
				{
					startOrdinal: 3,
					endOrdinal: 3,
					startPtsUs: 300_000,
					endPtsUs: 300_000,
					peakOrdinal: 3,
					peakPtsUs: 300_000,
					peakRatio: 0.5,
				},
				{
					startOrdinal: 25,
					endOrdinal: 25,
					startPtsUs: 2_500_000,
					endPtsUs: 2_500_000,
					peakOrdinal: 25,
					peakPtsUs: 2_500_000,
					peakRatio: 0.4,
				},
			],
		};
		const ctx = createInspectionContext(withIsolated, {
			videoPath: STATIC_FIXTURE.path,
			workspaceDir: workdir,
			isolatedMaxWindows: 1, // only room for the strongest one
			mandatoryMaxGroups: 10,
		});
		expect(ctx.isolatedFocusWindows.length).toBe(1);
		expect(ctx.isolatedFocusWindows[0]!.peakOrdinals).toEqual([3]); // strongest kept
		const status = ctx.status();
		// The weaker one overflowed -> surfaced as an unsatisfiable segment (forces partial).
		expect(status.unsatisfiedIsolatedTransients?.length).toBe(1);
		expect(status.unsatisfiedIsolatedTransients?.[0]).toMatchObject({ startMs: 2500 });
	});
});
