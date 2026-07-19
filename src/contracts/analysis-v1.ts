/**
 * Initial `AnalysisResultV1` submit-payload contract (M0).
 *
 * This is the semantic payload the analyst's `submit_analysis` tool accepts. The
 * deterministic `source` and `provenance` fields from the full schema in the
 * implementation plan are injected by the CLI and are intentionally NOT part of
 * this payload. The schema is deliberately scoped to what M0 needs to prove that
 * a schema-valid structured submission can be captured and validated without
 * parsing assistant prose; the full validator lands in M1.
 */
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const Confidence = Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
	$id: "Confidence",
});

const Motion = Type.Union([
	Type.Literal("none"),
	Type.Literal("local-animation"),
	Type.Literal("scroll"),
	Type.Literal("global-transition"),
	Type.Literal("unknown"),
]);

const TimeRange = Type.Object({
	startMs: Type.Number(),
	endMs: Type.Number(),
});

const EvidenceCitation = Type.Object({
	frameId: Type.String({ minLength: 1 }),
	ptsMs: Type.Number(),
	role: Type.Union([
		Type.Literal("representative"),
		Type.Literal("before"),
		Type.Literal("after"),
		Type.Literal("boundary"),
		Type.Literal("text-detail"),
	]),
});

const Inference = Type.Object({
	statement: Type.String({ minLength: 1 }),
	basis: Type.Literal("inference"),
});

const DebugBeat = Type.Object({
	id: Type.String({ pattern: "^B\\d+$" }),
	time: Type.Object({
		startMs: Type.Number(),
		endMs: Type.Number(),
		precisionMs: Type.Number(),
	}),
	kind: Type.Union([Type.Literal("state"), Type.Literal("transition"), Type.Literal("transient")]),
	observation: Type.Object({
		summary: Type.String({ minLength: 1 }),
		visibleText: Type.Array(Type.String()),
		motion: Motion,
	}),
	transitionFromPrevious: Type.Optional(Type.String()),
	evidence: Type.Array(EvidenceCitation),
	confidence: Confidence,
	inferences: Type.Array(Inference),
});

const SuggestedInvestigation = Type.Object({
	statement: Type.String({ minLength: 1 }),
	kind: Type.Union([Type.Literal("inference"), Type.Literal("action")]),
});

const Anomaly = Type.Object({
	category: Type.Union([
		Type.Literal("loading"),
		Type.Literal("contradictory-state"),
		Type.Literal("persistent-overlay"),
		Type.Literal("failed-action"),
		Type.Literal("incremental-render"),
		Type.Literal("navigation"),
		Type.Literal("other"),
	]),
	severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
	description: Type.String({ minLength: 1 }),
	whySuspicious: Type.String({ minLength: 1 }),
	beatIds: Type.Array(Type.String()),
	evidence: Type.Array(EvidenceCitation),
	inference: Type.Optional(Type.String()),
	confidence: Confidence,
	uncertainties: Type.Array(Type.String()),
});

/**
 * Deterministic source fingerprint. The CLI derives every field from the file and
 * the frame catalog; the model never supplies these values.
 */
export const SourceSchema = Type.Object({
	basename: Type.String({ minLength: 1 }),
	sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
	durationMs: Type.Integer({ minimum: 0 }),
	width: Type.Integer({ minimum: 1 }),
	height: Type.Integer({ minimum: 1 }),
	streamIndex: Type.Integer({ minimum: 0 }),
	averageFps: Type.Number({ minimum: 0 }),
});

/**
 * Deterministic run provenance. Call/image counts come from runtime state, not the
 * model, so these are injected by the CLI alongside the source fingerprint.
 */
export const ProvenanceSchema = Type.Object({
	toolVersion: Type.String({ minLength: 1 }),
	ffmpegVersion: Type.String({ minLength: 1 }),
	analystModel: Type.String({ minLength: 1 }),
	reviewerModel: Type.Optional(Type.String({ minLength: 1 })),
	inspectionCalls: Type.Integer({ minimum: 0 }),
	inspectedCells: Type.Integer({ minimum: 0 }),
	fullResolutionFrames: Type.Integer({ minimum: 0 }),
});

const submitPayloadProperties = {
	schemaVersion: Type.Literal("1"),
	status: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
	coverage: Type.Object({
		analyzedStartMs: Type.Number(),
		analyzedEndMs: Type.Number(),
		uninspectedRanges: Type.Array(TimeRange),
		confidence: Confidence,
	}),
	summary: Type.Object({
		observedFailure: Type.String({ minLength: 1 }),
		chronology: Type.String({ minLength: 1 }),
	}),
	beats: Type.Array(DebugBeat),
	anomalies: Type.Array(Anomaly),
	handoff: Type.Object({
		reproductionSteps: Type.Array(Type.String()),
		suggestedInvestigations: Type.Array(SuggestedInvestigation),
		uncertainties: Type.Array(Type.String()),
	}),
};

export const SubmitAnalysisPayloadSchema = Type.Object(submitPayloadProperties);

export type SubmitAnalysisPayload = Static<typeof SubmitAnalysisPayloadSchema>;

/**
 * The canonical, complete result. JSON is authoritative; the Markdown renderer is
 * a pure function over a validated value of this shape. The deterministic `source`
 * and `provenance` fields are injected by the CLI and are not part of the model's
 * `submit_analysis` payload.
 */
export const AnalysisResultV1Schema = Type.Object({
	...submitPayloadProperties,
	source: SourceSchema,
	provenance: ProvenanceSchema,
});

export type AnalysisSource = Static<typeof SourceSchema>;
export type AnalysisProvenance = Static<typeof ProvenanceSchema>;
export type AnalysisResultV1 = Static<typeof AnalysisResultV1Schema>;
export type DebugBeat = AnalysisResultV1["beats"][number];
export type Anomaly = AnalysisResultV1["anomalies"][number];
export type EvidenceCitation = DebugBeat["evidence"][number];

export type ValidationResult = { ok: true; value: SubmitAnalysisPayload } | { ok: false; errors: string[] };

export type SchemaCheckResult = { ok: true; value: AnalysisResultV1 } | { ok: false; errors: string[] };

/**
 * Inject the deterministic `source`/`provenance` fields into a validated semantic
 * payload, producing a complete `AnalysisResultV1`. The payload is deep-cloned so
 * the returned value never aliases the caller's input and the composed result can
 * be frozen independently.
 */
export function composeAnalysisResult(
	payload: SubmitAnalysisPayload,
	deterministic: { source: AnalysisSource; provenance: AnalysisProvenance },
): AnalysisResultV1 {
	return {
		...structuredClone(payload),
		source: structuredClone(deterministic.source),
		provenance: structuredClone(deterministic.provenance),
	};
}

/**
 * Structural (schema-only) check of a complete `AnalysisResultV1`. Deterministic
 * semantic/citation invariants live in `contracts/validation.ts`.
 */
export function validateAnalysisResultSchema(value: unknown): SchemaCheckResult {
	if (!Value.Check(AnalysisResultV1Schema, value)) {
		const errors: string[] = [];
		for (const error of Value.Errors(AnalysisResultV1Schema, value)) {
			const path = error.instancePath === "" ? "(root)" : error.instancePath;
			errors.push(`${path}: ${error.message}`);
		}
		return { ok: false, errors: dedupe(errors) };
	}
	return { ok: true, value: value as AnalysisResultV1 };
}

/**
 * Validate a candidate submit payload. Returns structured errors instead of
 * throwing, so a caller can feed concrete repair instructions back to the agent.
 * Never inspects or trusts free-form prose.
 */
export function validateSubmitPayload(value: unknown): ValidationResult {
	const errors: string[] = [];

	if (!Value.Check(SubmitAnalysisPayloadSchema, value)) {
		// typebox surfaces AJV-style errors keyed by `instancePath` (e.g. "/schemaVersion").
		for (const error of Value.Errors(SubmitAnalysisPayloadSchema, value)) {
			const path = error.instancePath === "" ? "(root)" : error.instancePath;
			errors.push(`${path}: ${error.message}`);
		}
		return { ok: false, errors: dedupe(errors) };
	}

	// Structure is valid; apply the M0 semantic invariants.
	const payload = value as SubmitAnalysisPayload;
	semanticErrors(payload, errors);
	if (errors.length > 0) return { ok: false, errors: dedupe(errors) };

	return { ok: true, value: payload };
}

function semanticErrors(payload: SubmitAnalysisPayload, errors: string[]): void {
	// Beats must be ordered by start time.
	for (let i = 1; i < payload.beats.length; i++) {
		const prev = payload.beats[i - 1]!;
		const curr = payload.beats[i]!;
		if (curr.time.startMs < prev.time.startMs) {
			errors.push(`beats[${i}] (${curr.id}) is out of order: startMs ${curr.time.startMs} < ${prev.time.startMs}`);
		}
	}

	// Every anomaly beat reference must resolve to a declared beat id.
	const beatIds = new Set(payload.beats.map((b) => b.id));
	payload.anomalies.forEach((anomaly, index) => {
		for (const beatId of anomaly.beatIds) {
			if (!beatIds.has(beatId)) {
				errors.push(`anomalies[${index}] references unknown beat id ${beatId}`);
			}
		}
	});
}

function dedupe(errors: string[]): string[] {
	return [...new Set(errors)];
}
