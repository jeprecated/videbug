/**
 * Reviewer submission contract (`submit_review`), implementation plan §9.
 *
 * The independent reviewer never patches the analyst's draft. It may only:
 *   - `accept` the validated draft UNCHANGED, with an evidence-backed rationale; or
 *   - `replace` it with a COMPLETE replacement `AnalysisResultV1` semantic payload,
 *     which must pass exactly the same deterministic validator as the analyst's.
 *
 * There are deliberately no patch, merge, or partial-diff semantics: an `accept`
 * that carries a replacement, or a `replace` with no replacement, is a contract
 * violation and is rejected with concrete repair errors. The structured payload is
 * the only thing read from the reviewer — assistant prose is never parsed.
 */
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { SubmitAnalysisPayloadSchema, validateSubmitPayload } from "./analysis-v1.ts";

export const SubmitReviewPayloadSchema = Type.Object({
	verdict: Type.Union([Type.Literal("accept"), Type.Literal("replace")]),
	/** Evidence-backed reasoning for the verdict. Never parsed for a result. */
	rationale: Type.String({ minLength: 1 }),
	/**
	 * A COMPLETE replacement analysis payload. Required for `replace`, forbidden for
	 * `accept`. No patch/partial-diff form exists.
	 */
	replacement: Type.Optional(SubmitAnalysisPayloadSchema),
});

export type SubmitReviewPayload = Static<typeof SubmitReviewPayloadSchema>;

export type ReviewValidationResult = { ok: true; value: SubmitReviewPayload } | { ok: false; errors: string[] };

/**
 * Validate a `submit_review` payload's structure and accept/replace contract, then
 * (for `replace`) the replacement's standalone semantic shape. The submit_review
 * tool subsequently applies its reviewer-live registry/coverage validator to the
 * payload selected by EITHER verdict (retained draft or replacement). Returns
 * concrete errors instead of throwing so the reviewer can receive a bounded repair.
 */
export function validateSubmitReviewPayload(value: unknown): ReviewValidationResult {
	if (!Value.Check(SubmitReviewPayloadSchema, value)) {
		const errors: string[] = [];
		for (const error of Value.Errors(SubmitReviewPayloadSchema, value)) {
			const path = error.instancePath === "" ? "(root)" : error.instancePath;
			errors.push(`${path}: ${error.message}`);
		}
		return { ok: false, errors: dedupe(errors) };
	}

	const payload = value as SubmitReviewPayload;
	const errors: string[] = [];

	if (payload.verdict === "accept" && payload.replacement !== undefined) {
		errors.push(
			"an 'accept' verdict must not include a replacement; accept keeps the analyst draft unchanged (there is no patch or partial form)",
		);
	}
	if (payload.verdict === "replace") {
		if (payload.replacement === undefined) {
			errors.push("a 'replace' verdict requires a complete replacement AnalysisResultV1 payload");
		} else {
			const replacementCheck = validateSubmitPayload(payload.replacement);
			if (!replacementCheck.ok) {
				for (const error of replacementCheck.errors) errors.push(`replacement: ${error}`);
			}
		}
	}

	if (errors.length > 0) return { ok: false, errors: dedupe(errors) };
	return { ok: true, value: payload };
}

function dedupe(errors: string[]): string[] {
	return [...new Set(errors)];
}
