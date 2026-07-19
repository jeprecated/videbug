import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// FFmpeg fixture generation + probing needs headroom beyond the default 5s.
		testTimeout: 30_000,
		hookTimeout: 60_000,
	},
});
