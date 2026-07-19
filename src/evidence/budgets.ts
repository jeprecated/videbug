/**
 * Inspection budgets and a fail-closed consumption ledger (implementation plan §11).
 *
 * Budgets are enforced inside tool execution, not only in the prompt. The ledger
 * tracks how much of each per-session budget has been consumed and rejects any
 * request that would exceed a limit — atomically, so a partially-affordable
 * multi-resource request consumes nothing. Enforcement here is deterministic and
 * unit-testable without spawning ffmpeg or a model.
 */

export interface InspectionBudgets {
	/** Maximum `inspect_range` calls per session. */
	rangeInspections: number;
	/** Maximum `inspect_overview` calls per session. */
	overviewInspections: number;
	/** Maximum total contact-sheet cells rendered across all sheets. */
	cells: number;
	/** Maximum `inspect_frame` full-resolution frames. */
	fullResolutionFrames: number;
	/** Maximum `compare_evidence` calls. */
	comparisons: number;
	/** Contact sheet maximum width/height in pixels. */
	sheetMaxDimension: number;
	/** Contact sheet maximum encoded size in bytes. */
	sheetMaxBytes: number;
}

/** Standard analyst-session defaults (implementation plan §11). */
export const DEFAULT_BUDGETS: InspectionBudgets = {
	rangeInspections: 12,
	overviewInspections: 4,
	cells: 250,
	fullResolutionFrames: 12,
	comparisons: 8,
	sheetMaxDimension: 4096,
	sheetMaxBytes: 5 * 1024 * 1024,
};

/**
 * Historical frozen-evaluation reviewer budget, half the analyst limits
 * (implementation plan §11). Production uses this only as an auto-scaling minimum.
 * Sheet dimension/byte caps are provider constraints and are not halved.
 */
export const REVIEWER_BUDGETS: InspectionBudgets = {
	rangeInspections: 6,
	overviewInspections: 2,
	cells: 125,
	fullResolutionFrames: 6,
	comparisons: 4,
	sheetMaxDimension: DEFAULT_BUDGETS.sheetMaxDimension,
	sheetMaxBytes: DEFAULT_BUDGETS.sheetMaxBytes,
};

/** The spendable (count-based) budget categories the ledger accounts for. */
export type BudgetCategory =
	| "rangeInspections"
	| "overviewInspections"
	| "cells"
	| "fullResolutionFrames"
	| "comparisons";

const CATEGORIES: readonly BudgetCategory[] = [
	"rangeInspections",
	"overviewInspections",
	"cells",
	"fullResolutionFrames",
	"comparisons",
];

export type BudgetConsumeResult = { ok: true } | { ok: false; message: string };

export type BudgetUsage = Record<BudgetCategory, { used: number; limit: number; remaining: number }>;

/**
 * A single-session consumption ledger. Every `consume` is all-or-nothing: it
 * checks every requested category against its remaining limit and only mutates
 * state when the whole request fits, so a rejected request never partially spends.
 */
export class BudgetLedger {
	private readonly used: Record<BudgetCategory, number> = {
		rangeInspections: 0,
		overviewInspections: 0,
		cells: 0,
		fullResolutionFrames: 0,
		comparisons: 0,
	};

	constructor(readonly budgets: InspectionBudgets) {}

	/** Would this request fit without consuming anything? */
	canAfford(request: Partial<Record<BudgetCategory, number>>): BudgetConsumeResult {
		for (const category of CATEGORIES) {
			const amount = request[category] ?? 0;
			if (amount <= 0) continue;
			const limit = this.budgets[category];
			if (this.used[category] + amount > limit) {
				const remaining = limit - this.used[category];
				return {
					ok: false,
					message: `${category} budget exhausted: requested ${amount} but only ${remaining} of ${limit} remain`,
				};
			}
		}
		return { ok: true };
	}

	/** Consume the request atomically; returns a rejection and mutates nothing on overflow. */
	consume(request: Partial<Record<BudgetCategory, number>>): BudgetConsumeResult {
		const affordable = this.canAfford(request);
		if (!affordable.ok) return affordable;
		for (const category of CATEGORIES) {
			this.used[category] += request[category] ?? 0;
		}
		return { ok: true };
	}

	remaining(category: BudgetCategory): number {
		return this.budgets[category] - this.used[category];
	}

	usage(): BudgetUsage {
		const usage = {} as BudgetUsage;
		for (const category of CATEGORIES) {
			usage[category] = {
				used: this.used[category],
				limit: this.budgets[category],
				remaining: this.budgets[category] - this.used[category],
			};
		}
		return usage;
	}
}
