import { beforeAll, describe, expect, it } from "vitest";
import { runEvidenceEngine } from "../../src/app/evidence-engine.ts";
import { FfmpegError } from "../../src/video/ffmpeg.ts";
import {
	CFR_FIXTURE,
	HIDDEN_TRANSIENT_FIXTURE,
	LOCAL_TRANSIENT_FIXTURE,
	STATIC_FIXTURE,
	ensureFixtures,
} from "../helpers/fixtures.ts";

beforeAll(async () => {
	await ensureFixtures();
});

describe("runEvidenceEngine", () => {
	it("produces a typed deterministic intermediate result end-to-end", async () => {
		const result = await runEvidenceEngine(CFR_FIXTURE.path);

		expect(result.source.basename).toBe("cfr-10fps.mp4");
		expect(result.source.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(result.catalog.frames).toHaveLength(CFR_FIXTURE.frameCount);
		// Scan associates one-for-one with the catalog (streamed, not buffered).
		expect(result.scan.frameCount).toBe(result.catalog.frames.length);
		expect(result.signals).toHaveLength(result.catalog.frames.length);
		expect(result.scan.policy.mode).toBe("full");
		expect(result.rescan.performed).toBe(false);
		expect(result.ffmpegVersion.toLowerCase()).toContain("ffmpeg");
		expect(Array.isArray(result.candidates)).toBe(true);
	});

	it("surfaces a brief localized transient end-to-end (full-cadence candidate)", async () => {
		const result = await runEvidenceEngine(LOCAL_TRANSIENT_FIXTURE.path);
		expect(result.scan.policy.degraded).toBe(false);
		const nearFlash = result.candidates.filter(
			(c) => c.kind === "transient" && c.startOrdinal <= 11 && c.endOrdinal >= 10,
		);
		expect(nearFlash.length).toBeGreaterThanOrEqual(1);
	});

	it("degraded rescan recovers a sub-stride transient the strided pass skips", async () => {
		// frameLimit 5 with a 10fps source forces stride 2, sampling only even ordinals.
		const degradeOpts = { scan: { frameLimit: 5, maxScanFps: 8 } } as const;

		const withRescan = await runEvidenceEngine(HIDDEN_TRANSIENT_FIXTURE.path, degradeOpts);
		expect(withRescan.scan.policy.degraded).toBe(true);
		expect(withRescan.rescan.performed).toBe(true);
		expect(withRescan.rescan.fullCadenceFrames).toBe(HIDDEN_TRANSIENT_FIXTURE.frameCount);
		const recovered = withRescan.candidates.filter(
			(c) => c.kind === "transient" && c.startOrdinal <= 11 && c.endOrdinal >= 11,
		);
		expect(recovered.length).toBeGreaterThanOrEqual(1);

		// Without the rescan the strided pass cannot see the odd-frame flash.
		const noRescan = await runEvidenceEngine(HIDDEN_TRANSIENT_FIXTURE.path, {
			...degradeOpts,
			rescanDegraded: false,
		});
		expect(noRescan.rescan.performed).toBe(false);
		const missed = noRescan.candidates.filter(
			(c) => c.kind === "transient" && c.startOrdinal <= 11 && c.endOrdinal >= 11,
		);
		expect(missed).toHaveLength(0);
	});

	it("surfaces a stable window and boundary for the long-static fixture", async () => {
		const result = await runEvidenceEngine(STATIC_FIXTURE.path);
		const kinds = new Set(result.candidates.map((c) => c.kind));
		expect(kinds.has("stable")).toBe(true);
		expect(kinds.has("boundary")).toBe(true);
	});

	it("reports progress events for each deterministic phase", async () => {
		const phases: string[] = [];
		await runEvidenceEngine(CFR_FIXTURE.path, { onProgress: (event) => phases.push(event.phase) });
		expect(phases).toContain("probe");
		expect(phases).toContain("scan");
		expect(phases).toContain("candidates");
	});

	it("propagates cancellation via an aborted signal (fail-closed cleanup)", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(runEvidenceEngine(CFR_FIXTURE.path, { signal: controller.signal })).rejects.toBeInstanceOf(
			FfmpegError,
		);
	});
});
