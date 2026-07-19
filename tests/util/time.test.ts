import { describe, expect, it } from "vitest";
import { formatTimecode } from "../../src/util/time.ts";

describe("formatTimecode", () => {
	it("formats sub-minute timestamps as mm:ss.mmm", () => {
		expect(formatTimecode(57_500)).toBe("00:57.500");
		expect(formatTimecode(0)).toBe("00:00.000");
		expect(formatTimecode(1)).toBe("00:00.001");
	});

	it("formats multi-minute timestamps without wrapping minutes at 60", () => {
		expect(formatTimecode(128_640)).toBe("02:08.640");
		expect(formatTimecode(90_000)).toBe("01:30.000");
		expect(formatTimecode(2 * 3_600_000)).toBe("120:00.000");
	});

	it("clamps negative and non-finite inputs to zero", () => {
		expect(formatTimecode(-5)).toBe("00:00.000");
		expect(formatTimecode(Number.NaN)).toBe("00:00.000");
	});
});
