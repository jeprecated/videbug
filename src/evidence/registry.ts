/**
 * Evidence registry: the single source of truth for what evidence exists, what
 * has been inspected, and what the agent is authorized to reference (plan §7).
 *
 * It owns:
 *   - registered evidence records keyed by stable frame ID (PTS + content digest);
 *   - the set of inspected time ranges and their sampling density;
 *   - the duplicate/refinement rule that governs repeated range requests;
 *   - cited-versus-uncited tracking for later validation.
 *
 * Frame IDs are the only handle the agent has to evidence: `inspect_frame` and
 * `compare_evidence` resolve exclusively through `get`, so an ID that was never
 * registered cannot be used to reach an arbitrary path. All state transitions are
 * deterministic and directly unit-testable.
 */
import type { EvidenceRecord } from "./extract-evidence.ts";

export type InspectionReason = "boundary" | "transient" | "text" | "loading-duration" | "chronology" | "overview";

export interface InspectedRange {
	startMs: number;
	endMs: number;
	reason: InspectionReason;
	/** Samples per second across the range — the range's inspection density. */
	density: number;
	/** Number of frames sampled in this inspection. */
	samples: number;
}

export type RangeAdmission = { ok: true } | { ok: false; message: string };

/** Samples-per-second density for a range with `samples` frames over `[startMs,endMs]`. */
export function rangeDensity(startMs: number, endMs: number, samples: number): number {
	const spanMs = Math.max(1, Math.abs(endMs - startMs));
	return (samples * 1000) / spanMs;
}

export class EvidenceRegistry {
	private readonly records = new Map<string, EvidenceRecord>();
	/** Index from source frame ordinal to its registered record (first wins). */
	private readonly byOrdinal = new Map<number, EvidenceRecord>();
	private readonly inspected: InspectedRange[] = [];
	private readonly cited = new Set<string>();
	/**
	 * Source frame ordinals that have had a full-resolution `inspect_frame` read.
	 * SHARED across the analyst and a reviewer that reuses this registry, so a peak
	 * frame the analyst already read at full resolution counts for the reviewer too.
	 */
	private readonly fullResRead = new Set<number>();

	/** Register extracted evidence records. Re-registering an identical ID is a no-op. */
	register(records: readonly EvidenceRecord[]): void {
		for (const record of records) {
			if (!this.records.has(record.id)) this.records.set(record.id, record);
			if (!this.byOrdinal.has(record.ordinal)) this.byOrdinal.set(record.ordinal, record);
		}
	}

	has(id: string): boolean {
		return this.records.has(id);
	}

	get(id: string): EvidenceRecord | undefined {
		return this.records.get(id);
	}

	/** The registered record for a source frame ordinal, if any (for peak lookup). */
	getByOrdinal(ordinal: number): EvidenceRecord | undefined {
		return this.byOrdinal.get(ordinal);
	}

	/** Record that a source frame ordinal was read at full resolution (inspect_frame). */
	markFullResRead(ordinal: number): void {
		this.fullResRead.add(ordinal);
	}

	/** Whether a source frame ordinal has had a full-resolution read. */
	hasFullResRead(ordinal: number): boolean {
		return this.fullResRead.has(ordinal);
	}

	/** All registered IDs in stable (lexical == chronological) order. */
	ids(): string[] {
		return [...this.records.keys()].sort();
	}

	size(): number {
		return this.records.size;
	}

	inspectedRanges(): readonly InspectedRange[] {
		return this.inspected;
	}

	/**
	 * The duplicate/refinement rule (plan §8.3): a same-reason request is rejected
	 * at equal-or-lower density only when the union of prior same-reason ranges
	 * ALREADY COVERS its whole resolved span. Partial overlap is not duplication: a
	 * broader request that adds unseen territory must be admitted even when a tiny
	 * high-density point/subrange lies inside it. Different reasons remain
	 * independent. This prevents endpoint point samples from permanently poisoning
	 * a later chronology-gap closure.
	 */
	admitRange(startMs: number, endMs: number, reason: InspectionReason, density: number): RangeAdmission {
		const low = Math.min(startMs, endMs);
		const high = Math.max(startMs, endMs);
		const sameReason = this.inspected
			.filter((range) => range.reason === reason && range.endMs >= low && range.startMs <= high)
			.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

		let cursor = low;
		let blockingDensity = Number.NEGATIVE_INFINITY;
		for (const range of sameReason) {
			if (range.endMs < cursor) continue;
			if (range.startMs > cursor) break;
			blockingDensity = Math.max(blockingDensity, range.density);
			cursor = Math.max(cursor, range.endMs);
			if (cursor >= high) {
				if (density <= blockingDensity) {
					return {
						ok: false,
						message: `range [${low}, ${high}]ms for reason "${reason}" is already fully covered at equal or higher density (${density.toFixed(2)} <= ${blockingDensity.toFixed(2)} samples/s); increase density to refine it`,
					};
				}
				return { ok: true };
			}
		}
		return { ok: true };
	}

	/** Record that a range was inspected. Callers should `admitRange` first. */
	recordInspectedRange(range: InspectedRange): void {
		this.inspected.push({
			startMs: Math.min(range.startMs, range.endMs),
			endMs: Math.max(range.startMs, range.endMs),
			reason: range.reason,
			density: range.density,
			samples: range.samples,
		});
	}

	/** Mark a registered ID as cited. Citing an unknown ID is rejected. */
	markCited(id: string): boolean {
		if (!this.records.has(id)) return false;
		this.cited.add(id);
		return true;
	}

	citedIds(): string[] {
		return [...this.cited].sort();
	}

	uncitedIds(): string[] {
		return this.ids().filter((id) => !this.cited.has(id));
	}
}
