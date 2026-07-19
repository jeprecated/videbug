import { describe, expect, it, vi } from "vitest";
import { createRunCancellation } from "../../src/util/cancellation.ts";

describe("createRunCancellation", () => {
	it("produces an un-aborted signal with no timeout or interrupt", () => {
		const c = createRunCancellation();
		expect(c.signal.aborted).toBe(false);
		expect(c.reason()).toBeUndefined();
		c.dispose();
	});

	it("aborts the signal after the wall-clock timeout", async () => {
		vi.useFakeTimers();
		try {
			const c = createRunCancellation({ timeoutMs: 50 });
			expect(c.signal.aborted).toBe(false);
			vi.advanceTimersByTime(51);
			expect(c.signal.aborted).toBe(true);
			expect(c.reason()).toMatch(/timeout/i);
			c.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("aborts when the injected interrupt source fires", () => {
		let fire: (() => void) | undefined;
		const c = createRunCancellation({
			onInterrupt: (handler) => {
				fire = handler;
				return () => {
					fire = undefined;
				};
			},
		});
		expect(c.signal.aborted).toBe(false);
		fire?.();
		expect(c.signal.aborted).toBe(true);
		expect(c.reason()).toMatch(/interrupt|sigint/i);
		c.dispose();
	});

	it("dispose clears the timer and unregisters the interrupt handler", () => {
		vi.useFakeTimers();
		try {
			let registered = true;
			const c = createRunCancellation({
				timeoutMs: 50,
				onInterrupt: () => () => {
					registered = false;
				},
			});
			c.dispose();
			vi.advanceTimersByTime(100);
			expect(c.signal.aborted).toBe(false);
			expect(registered).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("only records the first abort reason", () => {
		let fire: (() => void) | undefined;
		const c = createRunCancellation({
			onInterrupt: (handler) => {
				fire = handler;
				return () => {};
			},
		});
		fire?.();
		fire?.();
		expect(c.reason()).toMatch(/interrupt/i);
		c.dispose();
	});
});
