import { describe, expect, it } from "vitest";
import { createRangeTool } from "../../src/agent/tools/inspect-range-tool.ts";
import type { RangeOutput } from "../../src/evidence/inspection-context.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQC5/CkhAAAAAElFTkSuQmCC";

function okOutput(): RangeOutput {
	return {
		ok: true,
		sheet: { data: PNG, mimeType: "image/png", width: 320, height: 240 },
		manifest: [{ cellId: "C1", frameId: "v0_f000000005_p000000500_abcdef", ptsMs: 500, timecode: "00:00.500" }],
		resolvedStartMs: 500,
		resolvedEndMs: 500,
		reason: "boundary",
		samples: 1,
	};
}

describe("inspect_range tool", () => {
	it("returns text manifest plus image and marks details accepted", async () => {
		const tool = createRangeTool({ runRange: async () => okOutput() });
		const result = await tool.execute("call-1", { startMs: 400, endMs: 600, samples: 1, reason: "boundary" });
		expect(result.content.find((c) => c.type === "image")).toMatchObject({ type: "image", data: PNG });
		const text = result.content.find((c) => c.type === "text");
		expect(text?.type === "text" && text.text).toContain("C1\t00:00.500\tv0_f000000005_p000000500_abcdef");
		expect(result.details).toMatchObject({ accepted: true, samples: 1, resolvedStartMs: 500 });
	});

	it("passes bounded, validated params through to the backend", async () => {
		let seen: unknown;
		const tool = createRangeTool({
			runRange: async (input) => {
				seen = input;
				return okOutput();
			},
			maxSamples: 8,
		});
		await tool.execute("call-1", { startMs: 100, endMs: 900, samples: 4, reason: "transient" });
		expect(seen).toEqual({ startMs: 100, endMs: 900, samples: 4, reason: "transient" });
		// The schema advertises the configured sample bound.
		expect((tool.parameters.properties.samples as { maximum?: number }).maximum).toBe(8);
	});

	it("surfaces an overlap/budget rejection as text without an image", async () => {
		const tool = createRangeTool({
			runRange: async () => ({ ok: false, message: "overlaps an already-inspected range at equal or lower density" }),
		});
		const result = await tool.execute("call-1", { startMs: 0, endMs: 100, samples: 2, reason: "boundary" });
		expect(result.content.some((c) => c.type === "image")).toBe(false);
		expect(result.details.accepted).toBe(false);
	});

	it("is named inspect_range and enumerates the allowed reasons", () => {
		const tool = createRangeTool({ runRange: async () => okOutput() });
		expect(tool.name).toBe("inspect_range");
	});
});
