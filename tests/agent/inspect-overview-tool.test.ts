import { describe, expect, it } from "vitest";
import { createOverviewTool } from "../../src/agent/tools/inspect-overview-tool.ts";
import type { OverviewOutput } from "../../src/evidence/inspection-context.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQC5/CkhAAAAAElFTkSuQmCC";

function okOutput(): OverviewOutput {
	return {
		ok: true,
		sheet: { data: PNG, mimeType: "image/png", width: 640, height: 480 },
		manifest: [
			{ cellId: "C1", frameId: "v0_f000000000_p000000000_aaaaaa", ptsMs: 0, timecode: "00:00.000" },
			{ cellId: "C2", frameId: "v0_f000000010_p000001000_bbbbbb", ptsMs: 1000, timecode: "00:01.000" },
		],
		candidateSummary: [{ kind: "boundary", startMs: 900, endMs: 1100, score: 1200, representativeOrdinal: 10 }],
	};
}

describe("inspect_overview tool", () => {
	it("returns an image block and a text manifest in matching cell order", async () => {
		const tool = createOverviewTool({ runOverview: async () => okOutput() });
		const result = await tool.execute("call-1", {});
		const image = result.content.find((c) => c.type === "image");
		const text = result.content.find((c) => c.type === "text");
		expect(image).toMatchObject({ type: "image", data: PNG, mimeType: "image/png" });
		expect(text?.type).toBe("text");
		if (text?.type === "text") {
			expect(text.text).toContain("C1\t00:00.000\tv0_f000000000_p000000000_aaaaaa");
			expect(text.text).toContain("C2\t00:01.000\tv0_f000000010_p000001000_bbbbbb");
			// Manifest order (C1 before C2) matches the cells.
			expect(text.text.indexOf("C1\t")).toBeLessThan(text.text.indexOf("C2\t"));
			expect(text.text).toContain("candidate-windows");
		}
		expect(result.details).toMatchObject({ accepted: true, cells: 2 });
	});

	it("is named inspect_overview", () => {
		const tool = createOverviewTool({ runOverview: async () => okOutput() });
		expect(tool.name).toBe("inspect_overview");
	});

	it("surfaces a backend rejection as text without an image", async () => {
		const tool = createOverviewTool({ runOverview: async () => ({ ok: false, message: "cells budget exhausted" }) });
		const result = await tool.execute("call-1", {});
		expect(result.content.some((c) => c.type === "image")).toBe(false);
		expect(result.details.accepted).toBe(false);
		const text = result.content[0];
		expect(text?.type === "text" && text.text).toContain("cells budget exhausted");
	});
});
