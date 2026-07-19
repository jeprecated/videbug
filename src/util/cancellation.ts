/**
 * Run-level cancellation: a single `AbortSignal` driven by a wall-clock timeout
 * and/or an interrupt (SIGINT) source (implementation plan §11).
 *
 * The signal is threaded from the CLI down through the analysis flow into the Pi
 * session runner and every ffmpeg child, so a timeout or Ctrl-C deterministically
 * aborts in-flight work and the private workspace is still cleaned up on the way
 * out. The interrupt source is injected (not hard-wired to `process`) so the wiring
 * is unit-testable without sending real signals.
 */
export interface CancellationOptions {
	/** Abort the run after this many milliseconds. Omit/<=0 for no timeout. */
	timeoutMs?: number;
	/**
	 * Register an interrupt (e.g. SIGINT) handler and return an unregister function.
	 * Injected so tests can drive interruption deterministically.
	 */
	onInterrupt?: (handler: () => void) => () => void;
}

export interface RunCancellation {
	signal: AbortSignal;
	/** Reason the run was aborted, once it has been (timeout vs. interrupt). */
	reason(): string | undefined;
	/** Clear the timer and unregister the interrupt handler. Idempotent. */
	dispose(): void;
}

export function createRunCancellation(options: CancellationOptions = {}): RunCancellation {
	const controller = new AbortController();
	let abortReason: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let unregister: (() => void) | undefined;

	const abort = (reason: string) => {
		if (controller.signal.aborted) return;
		abortReason = reason;
		controller.abort(new Error(reason));
	};

	if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
		timer = setTimeout(() => abort(`wall-clock timeout after ${options.timeoutMs}ms`), options.timeoutMs);
		// Do not keep the event loop alive solely for the timeout.
		timer.unref?.();
	}
	if (options.onInterrupt) {
		unregister = options.onInterrupt(() => abort("interrupted (SIGINT)"));
	}

	return {
		signal: controller.signal,
		reason: () => abortReason,
		dispose: () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			unregister?.();
			unregister = undefined;
		},
	};
}
