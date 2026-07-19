import { describe, expect, it } from "vitest";
import { VisionModelError, assertVisionCapable, isVisionCapable } from "../../src/agent/vision-capability.ts";

describe("vision capability", () => {
	it("treats models whose input includes image as vision-capable", () => {
		expect(isVisionCapable({ input: ["text", "image"] })).toBe(true);
	});

	it("treats text-only models as not vision-capable", () => {
		expect(isVisionCapable({ input: ["text"] })).toBe(false);
	});

	it("assertVisionCapable throws a typed error for text-only models", () => {
		expect(() => assertVisionCapable({ provider: "p", id: "m", input: ["text"] })).toThrow(VisionModelError);
	});

	it("assertVisionCapable returns the model for vision models", () => {
		const model = { provider: "p", id: "m", input: ["text", "image"] as const };
		expect(assertVisionCapable(model)).toBe(model);
	});
});
