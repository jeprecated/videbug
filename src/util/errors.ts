/**
 * Typed application errors and process exit codes.
 *
 * The product contract (implementation plan §4) fixes exit codes 0 and 2–7 to
 * specific failure classes. Each error below carries its exit code so the CLI can
 * translate a thrown error into the correct process exit without a scattered
 * switch. Unexpected (non-`AppError`) failures resolve to a generic exit code 1,
 * which is deliberately not one of the documented, validated-run codes.
 */

export const ExitCode = {
	/** Complete, validated analysis. */
	Success: 0,
	/** Invalid CLI arguments or unsupported input. */
	InvalidArguments: 2,
	/** FFmpeg/FFprobe/probing/extraction failure. */
	FfmpegFailure: 3,
	/** Pi auth/model unavailable or model lacks image support. */
	PiUnavailable: 4,
	/** A validated structured partial was submitted after an inspection constraint. */
	BudgetExhausted: 5,
	/** Agent failed to submit a valid result after one repair turn. */
	AgentSubmissionFailed: 6,
	/** Independent reviewer rejected the result without a valid replacement. */
	ReviewerRejected: 7,
	/** A code path that is intentionally not implemented yet (later milestones). */
	NotImplemented: 70,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export interface AppErrorOptions {
	exitCode: ExitCode;
	code: string;
	cause?: unknown;
}

/** Base class for all errors the CLI is expected to translate into an exit code. */
export class AppError extends Error {
	readonly exitCode: ExitCode;
	readonly code: string;

	constructor(message: string, options: AppErrorOptions) {
		super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = new.target.name;
		this.exitCode = options.exitCode;
		this.code = options.code;
	}
}

export class InvalidArgumentsError extends AppError {
	constructor(message: string, cause?: unknown) {
		super(message, { exitCode: ExitCode.InvalidArguments, code: "INVALID_ARGUMENTS", cause });
	}
}

export class FfmpegFailureError extends AppError {
	constructor(message: string, cause?: unknown) {
		super(message, { exitCode: ExitCode.FfmpegFailure, code: "FFMPEG_FAILURE", cause });
	}
}

export class PiUnavailableError extends AppError {
	constructor(message: string, cause?: unknown) {
		super(message, { exitCode: ExitCode.PiUnavailable, code: "PI_UNAVAILABLE", cause });
	}
}

export class BudgetExhaustedError extends AppError {
	constructor(message: string, cause?: unknown) {
		super(message, { exitCode: ExitCode.BudgetExhausted, code: "BUDGET_EXHAUSTED", cause });
	}
}

export class AgentSubmissionError extends AppError {
	constructor(message: string, cause?: unknown) {
		super(message, { exitCode: ExitCode.AgentSubmissionFailed, code: "AGENT_SUBMISSION_FAILED", cause });
	}
}

export class ReviewerRejectedError extends AppError {
	constructor(message: string, cause?: unknown) {
		super(message, { exitCode: ExitCode.ReviewerRejected, code: "REVIEWER_REJECTED", cause });
	}
}

/**
 * A genuinely unimplemented code path. The analysis pipeline is fully implemented
 * and no current path throws this; the typed error and its distinct non-product
 * exit code (70) remain reserved so any future unimplemented path fails loudly and
 * honestly instead of fabricating output.
 */
export class NotImplementedError extends AppError {
	constructor(message: string, cause?: unknown) {
		super(message, { exitCode: ExitCode.NotImplemented, code: "NOT_IMPLEMENTED", cause });
	}
}

/** Resolve any thrown value to a process exit code. */
export function resolveExitCode(error: unknown): number {
	if (error instanceof AppError) return error.exitCode;
	return 1;
}
