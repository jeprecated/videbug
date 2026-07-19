import { describe, expect, it } from "vitest";
import {
	AgentSubmissionError,
	AppError,
	BudgetExhaustedError,
	ExitCode,
	FfmpegFailureError,
	InvalidArgumentsError,
	NotImplementedError,
	PiUnavailableError,
	ReviewerRejectedError,
	resolveExitCode,
} from "../../src/util/errors.ts";

describe("typed application errors and exit codes", () => {
	it("maps each documented failure to its product exit code", () => {
		expect(new InvalidArgumentsError("bad").exitCode).toBe(ExitCode.InvalidArguments);
		expect(new InvalidArgumentsError("bad").exitCode).toBe(2);
		expect(new FfmpegFailureError("x").exitCode).toBe(3);
		expect(new PiUnavailableError("x").exitCode).toBe(4);
		expect(new BudgetExhaustedError("x").exitCode).toBe(5);
		expect(new AgentSubmissionError("x").exitCode).toBe(6);
		expect(new ReviewerRejectedError("x").exitCode).toBe(7);
	});

	it("uses a distinct non-product exit code for not-yet-implemented paths", () => {
		const err = new NotImplementedError("reserved unimplemented path");
		expect(err.exitCode).toBe(ExitCode.NotImplemented);
		expect(err.exitCode).not.toBe(0);
		expect([2, 3, 4, 5, 6, 7]).not.toContain(err.exitCode);
	});

	it("are all AppError and Error instances with a stable name and code", () => {
		const err = new InvalidArgumentsError("bad");
		expect(err).toBeInstanceOf(AppError);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("InvalidArgumentsError");
		expect(err.code).toBe("INVALID_ARGUMENTS");
	});

	it("resolveExitCode returns the AppError exit code", () => {
		expect(resolveExitCode(new ReviewerRejectedError("x"))).toBe(7);
	});

	it("resolveExitCode returns generic 1 for unexpected errors", () => {
		expect(resolveExitCode(new Error("boom"))).toBe(1);
		expect(resolveExitCode("not an error")).toBe(1);
	});
});
