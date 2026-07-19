import { describe, expect, it } from "vitest";
import { createInspectionTools } from "../../src/agent/inspection-tools.ts";
import type { InspectionProgressEvent } from "../../src/app/inspection-progress.ts";
import type {
	InspectionContext,
	InspectionStatus,
	OverviewOutput,
	RangeOutput,
} from "../../src/evidence/inspection-context.ts";

function mkStatus(overrides: Partial<InspectionStatus> = {}): InspectionStatus {
	return {
		budgets: {
			rangeInspections: { used: 0, limit: 12, remaining: 12 },
			overviewInspections: { used: 0, limit: 4, remaining: 4 },
			cells: { used: 0, limit: 250, remaining: 250 },
			fullResolutionFrames: { used: 0, limit: 12, remaining: 12 },
			comparisons: { used: 0, limit: 8, remaining: 8 },
		} as unknown as InspectionStatus["budgets"],
		registeredFrames: 3,
		inspectedRanges: [],
		uninspectedCandidates: [],
		mandatoryWindows: [],
		largeGaps: [],
		...overrides,
	} as InspectionStatus;
}

const sheet = { data: "b64", mimeType: "image/png" as const, width: 10, height: 10 };

/** A fake InspectionContext exposing only what createInspectionTools calls. */
function fakeContext(overrides: Partial<InspectionContext> = {}): InspectionContext {
	const overview: OverviewOutput = {
		ok: true,
		sheet,
		manifest: [{ frameId: "f0", ptsMs: 0, cell: 0 }],
		candidateSummary: [],
	} as unknown as OverviewOutput;
	const rangeOut: RangeOutput = {
		ok: true,
		sheet,
		manifest: [
			{ frameId: "f1", ptsMs: 12000, cell: 0 },
			{ frameId: "f2", ptsMs: 23000, cell: 1 },
		],
		resolvedStartMs: 12000,
		resolvedEndMs: 23000,
		reason: "chronology",
		samples: 2,
	} as unknown as RangeOutput;
	return {
		maxRangeSamples: 24,
		registry: {
			get: (id: string) => (id === "f_00042" ? { id, ptsMs: 57097 } : undefined),
		} as unknown as InspectionContext["registry"],
		runOverview: async () => overview,
		runRange: async () => rangeOut,
		loadFrame: async () => ({ data: "b64", mimeType: "image/png", width: 500, height: 1080 }),
		runCompare: async () =>
			({
				pairs: [
					{
						fromId: "f1",
						toId: "f2",
						absDiffMean: 1,
						changedPixelRatio: 0.1,
						dHashDistance: 2,
						changedCells: 3,
						grid: [],
					},
				],
			}) as never,
		status: () => mkStatus(),
		...overrides,
	} as unknown as InspectionContext;
}

describe("createInspectionTools instrumentation", () => {
	it("returns five uninstrumented tools when no callback is given", () => {
		const tools = createInspectionTools(fakeContext());
		expect(tools.map((t) => t.name)).toEqual([
			"inspect_overview",
			"inspect_range",
			"inspect_frame",
			"compare_evidence",
			"get_inspection_status",
		]);
	});

	it("emits an overview event with the result details and a live status snapshot", async () => {
		const events: InspectionProgressEvent[] = [];
		const [overview] = createInspectionTools(fakeContext(), { onInspection: (e) => events.push(e) });
		await overview.execute("call", {});
		expect(events).toHaveLength(1);
		expect(events[0]!.tool).toBe("inspect_overview");
		const ev = events[0]!;
		if (ev.tool !== "inspect_overview") throw new Error("wrong tool");
		expect(ev.details.accepted).toBe(true);
		expect(ev.status.registeredFrames).toBe(3);
	});

	it("emits a range event carrying the request shape (range/reason/count) and details", async () => {
		const events: InspectionProgressEvent[] = [];
		const tools = createInspectionTools(fakeContext(), { onInspection: (e) => events.push(e) });
		const range = tools[1];
		await range.execute("call", { startMs: 12000, endMs: 23000, samples: 18, reason: "chronology" });
		const ev = events[0]!;
		if (ev.tool !== "inspect_range") throw new Error("wrong tool");
		expect(ev.request).toEqual({ startMs: 12000, endMs: 23000, samples: 18, reason: "chronology" });
		expect(ev.details.samples).toBe(2);
	});

	it("enriches an inspect_frame event with the frame's exact registered PTS", async () => {
		const events: InspectionProgressEvent[] = [];
		const tools = createInspectionTools(fakeContext(), { onInspection: (e) => events.push(e) });
		const frame = tools[2];
		await frame.execute("call", { frameId: "f_00042" });
		const ev = events[0]!;
		if (ev.tool !== "inspect_frame") throw new Error("wrong tool");
		expect("ptsMs" in ev && ev.ptsMs).toBe(57097);
		expect("rejection" in ev).toBe(false);
	});

	it("classifies an inspect_frame allowance rejection safely and rethrows", async () => {
		const events: InspectionProgressEvent[] = [];
		const context = fakeContext({
			loadFrame: async () => {
				throw new Error("fullResolutionFrames budget exhausted: requested 1 but only 0 of 30 remain");
			},
		});
		const tools = createInspectionTools(context, { onInspection: (e) => events.push(e) });
		const frame = tools[2];
		await expect(frame.execute("call", { frameId: "f_x" })).rejects.toThrow(/budget exhausted/);
		const ev = events[0]!;
		if (ev.tool !== "inspect_frame") throw new Error("wrong tool");
		expect("rejection" in ev && ev.rejection).toBe("allowance-unavailable");
		expect("ptsMs" in ev).toBe(false);
		expect(JSON.stringify(ev)).not.toContain("requested 1");
	});

	it("redacts hostile visible text, credentials, and paths from an unauthorized frame event", async () => {
		const hostile = "AWS_SECRET_ACCESS_KEY=leaked /home/user/.ssh/id_ed25519 visible screen text";
		const events: InspectionProgressEvent[] = [];
		const context = fakeContext({
			loadFrame: async () => {
				const error = new Error(`Frame ID ${hostile} is not in the evidence registry`);
				error.name = "FrameAuthorizationError";
				throw error;
			},
		});
		const tools = createInspectionTools(context, { onInspection: (e) => events.push(e) });
		await expect(tools[2].execute("call", { frameId: hostile })).rejects.toThrow(/evidence registry/);
		const ev = events[0]!;
		if (ev.tool !== "inspect_frame") throw new Error("wrong tool");
		expect("rejection" in ev && ev.rejection).toBe("unregistered-frame-id");
		expect(JSON.stringify(ev)).not.toContain(hostile);
		expect(JSON.stringify(ev)).not.toContain("AWS_SECRET_ACCESS_KEY");
		expect(JSON.stringify(ev)).not.toContain("/home/user");
	});

	it("emits a compare event with the frame count and a status snapshot", async () => {
		const events: InspectionProgressEvent[] = [];
		const tools = createInspectionTools(fakeContext(), { onInspection: (e) => events.push(e) });
		const compare = tools[3];
		await compare.execute("call", { frameIds: ["f1", "f2"] });
		const ev = events[0]!;
		if (ev.tool !== "compare_evidence") throw new Error("wrong tool");
		expect(ev.request.frameIds).toBe(2);
		expect(ev.details.accepted).toBe(true);
	});

	it("drops hostile backend text from rejected compare progress events", async () => {
		const hostile = "AWS_SECRET_ACCESS_KEY=leaked /home/user/.ssh/id_ed25519";
		const events: InspectionProgressEvent[] = [];
		const context = fakeContext({ runCompare: async () => ({ ok: false, message: hostile }) });
		const tools = createInspectionTools(context, { onInspection: (e) => events.push(e) });
		await tools[3].execute("call", { frameIds: [hostile, "f2"] });
		const serialized = JSON.stringify(events[0]);
		expect(serialized).not.toContain("AWS_SECRET_ACCESS_KEY");
		expect(serialized).not.toContain("/home/user");
	});

	it("emits a status event with just the live snapshot", async () => {
		const events: InspectionProgressEvent[] = [];
		const tools = createInspectionTools(fakeContext(), { onInspection: (e) => events.push(e) });
		const statusTool = tools[4];
		await statusTool.execute("call", {});
		expect(events[0]!.tool).toBe("get_inspection_status");
	});
});
