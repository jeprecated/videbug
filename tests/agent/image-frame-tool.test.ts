import { describe, expect, it } from "vitest";
import { createImageFrameTool } from "../../src/agent/tools/image-frame-tool.ts";

// 1x1 transparent PNG.
const PNG_1PX_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQC5/CkhAAAAAElFTkSuQmCC";

describe("createImageFrameTool", () => {
	it("returns registered frame content as an image block for the vision model", async () => {
		const tool = createImageFrameTool({
			loadFrame: async (frameId) => {
				if (frameId !== "v0_f000000_p000000_aaaaaa") throw new Error(`unknown frame ${frameId}`);
				return { data: PNG_1PX_BASE64, mimeType: "image/png", width: 1, height: 1 };
			},
		});

		const result = await tool.execute("call-1", { frameId: "v0_f000000_p000000_aaaaaa" });

		const image = result.content.find((c) => c.type === "image");
		expect(image).toBeDefined();
		expect(image).toMatchObject({ type: "image", data: PNG_1PX_BASE64, mimeType: "image/png" });
		expect(result.details.frameId).toBe("v0_f000000_p000000_aaaaaa");
	});

	it("rejects frame ids that are not in the registry (no arbitrary path access)", async () => {
		const tool = createImageFrameTool({
			loadFrame: async (frameId) => {
				throw new Error(`unknown frame ${frameId}`);
			},
		});

		await expect(tool.execute("call-1", { frameId: "../../etc/passwd" })).rejects.toThrow();
	});

	it("is named inspect_frame", () => {
		const tool = createImageFrameTool({
			loadFrame: async () => ({ data: PNG_1PX_BASE64, mimeType: "image/png", width: 1, height: 1 }),
		});
		expect(tool.name).toBe("inspect_frame");
	});
});
