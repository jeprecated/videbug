/**
 * Assemble the constrained inspection tool layer (implementation plan §8.3).
 *
 * These are the ONLY custom tools exposed to the analyst/reviewer session. Each is
 * backed by the M3 `InspectionContext`, so every operation is authorized through
 * the evidence registry and metered by the budget ledger. None can reach an
 * arbitrary path. `submit_analysis`/`submit_review` are added by the later
 * milestones that own the submission latch; this factory covers the read/inspect
 * surface only.
 *
 * An optional `onInspection` callback surfaces a DETERMINISTIC progress event after
 * each operation (tool input shape, structured result details, exact registered
 * PTS, and a live ledger snapshot) so the CLI can print human-readable progress.
 * The callback never receives model reasoning, prompt text, frame pixels, visible
 * text, or draft payloads — only the same deterministic facts the manifest records.
 */
import type { InspectionProgressEvent } from "../app/inspection-progress.ts";
import { FrameAuthorizationError, type InspectionContext } from "../evidence/inspection-context.ts";
import { createCompareEvidenceTool } from "./tools/compare-evidence-tool.ts";
import { createImageFrameTool } from "./tools/image-frame-tool.ts";
import { createOverviewTool } from "./tools/inspect-overview-tool.ts";
import { createRangeTool } from "./tools/inspect-range-tool.ts";
import { createInspectionStatusTool } from "./tools/inspection-status-tool.ts";

export interface InspectionToolsOptions {
	/**
	 * Optional deterministic progress sink. Called once per completed (or rejected)
	 * inspection operation with a privacy-safe event. Omit it and the tools are
	 * uninstrumented (behaviour identical to no callback).
	 */
	onInspection?: (event: InspectionProgressEvent) => void;
}

/** The five constrained inspection tools, in a stable order, bound to a context. */
export function createInspectionTools(context: InspectionContext, options: InspectionToolsOptions = {}) {
	const overview = createOverviewTool({ runOverview: () => context.runOverview() });
	const range = createRangeTool({ runRange: (input) => context.runRange(input), maxSamples: context.maxRangeSamples });
	const frame = createImageFrameTool({ loadFrame: (frameId) => context.loadFrame(frameId) });
	const compare = createCompareEvidenceTool({ runCompare: (frameIds) => context.runCompare(frameIds) });
	const status = createInspectionStatusTool({ status: () => context.status() });

	const onInspection = options.onInspection;
	if (!onInspection) {
		return [overview, range, frame, compare, status] as const;
	}

	const instrumentedOverview: typeof overview = {
		...overview,
		execute: async (id, params) => {
			const result = await overview.execute(id, params);
			const details = result.details.accepted ? result.details : { accepted: false, cells: 0 };
			onInspection({ tool: "inspect_overview", details, status: context.status() });
			return result;
		},
	};
	const instrumentedRange: typeof range = {
		...range,
		execute: async (id, params) => {
			const result = await range.execute(id, params);
			onInspection({
				tool: "inspect_range",
				request: { startMs: params.startMs, endMs: params.endMs, samples: params.samples, reason: params.reason },
				details: result.details.accepted ? result.details : { accepted: false, samples: 0 },
				status: context.status(),
			});
			return result;
		},
	};
	// inspect_frame throws on an unregistered id or unavailable full-res allowance.
	// Rejections are reduced to a fixed classification: never place the model-controlled
	// frame id or raw error message in the progress event. On success the registry has
	// authorized the id, so enrich it with the EXACT registered PTS (not visible text).
	const instrumentedFrame: typeof frame = {
		...frame,
		execute: async (id, params) => {
			try {
				const result = await frame.execute(id, params);
				const record = context.registry.get(params.frameId);
				onInspection({
					tool: "inspect_frame",
					request: { frameId: params.frameId },
					...(record ? { ptsMs: record.ptsMs } : {}),
					details: result.details,
					status: context.status(),
				});
				return result;
			} catch (error) {
				const rejection =
					error instanceof FrameAuthorizationError ||
					(error instanceof Error && error.name === "FrameAuthorizationError")
						? "unregistered-frame-id"
						: error instanceof Error && error.message.startsWith("fullResolutionFrames budget exhausted")
							? "allowance-unavailable"
							: "inspection-unavailable";
				onInspection({ tool: "inspect_frame", rejection, status: context.status() });
				throw error;
			}
		},
	};
	const instrumentedCompare: typeof compare = {
		...compare,
		execute: async (id, params) => {
			const result = await compare.execute(id, params);
			onInspection({
				tool: "compare_evidence",
				request: { frameIds: params.frameIds.length },
				details: result.details.accepted ? result.details : { accepted: false, pairs: 0 },
				status: context.status(),
			});
			return result;
		},
	};
	const instrumentedStatus: typeof status = {
		...status,
		execute: async (id, params) => {
			const result = await status.execute(id, params);
			onInspection({ tool: "get_inspection_status", status: context.status() });
			return result;
		},
	};

	return [instrumentedOverview, instrumentedRange, instrumentedFrame, instrumentedCompare, instrumentedStatus] as const;
}
