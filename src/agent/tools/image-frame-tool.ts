/**
 * `inspect_frame` custom tool.
 *
 * Returns a single registered frame as an image content block so a vision-capable
 * Pi model can read fine detail (small text, transient artifacts). The tool has no
 * filesystem or path access of its own: it can only resolve frame IDs through the
 * injected `loadFrame` resolver, which is backed by the run's evidence registry.
 * An unknown ID throws, so the agent cannot use it to reach arbitrary paths.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CustomVideoTool } from "./tool-types.ts";

export interface LoadedFrameImage {
	/** Base64-encoded image bytes. */
	data: string;
	mimeType: string;
	width: number;
	height: number;
}

export interface ImageFrameToolOptions {
	loadFrame(frameId: string): Promise<LoadedFrameImage>;
}

export interface ImageFrameToolDetails {
	frameId: string;
	width: number;
	height: number;
	mimeType: string;
}

const ParametersSchema = Type.Object({
	frameId: Type.String({ minLength: 1, description: "A frame ID present in the run's evidence registry." }),
});

export function createImageFrameTool(
	options: ImageFrameToolOptions,
): CustomVideoTool<typeof ParametersSchema, ImageFrameToolDetails> {
	return {
		name: "inspect_frame",
		label: "Inspect Frame",
		description:
			"Return one full-resolution frame by its registered frame ID for text/detail verification. Only registered IDs are accessible.",
		promptSnippet: "Fetch one full-resolution frame by registered frame ID",
		parameters: ParametersSchema,
		execute: async (_toolCallId, params): Promise<AgentToolResult<ImageFrameToolDetails>> => {
			const frame = await options.loadFrame(params.frameId);
			return {
				content: [{ type: "image", data: frame.data, mimeType: frame.mimeType }],
				details: {
					frameId: params.frameId,
					width: frame.width,
					height: frame.height,
					mimeType: frame.mimeType,
				},
			};
		},
	};
}
