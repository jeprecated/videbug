import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";

const here = dirname(fileURLToPath(import.meta.url));
export const ARTIFACT_DIR = resolve(here, "..", ".artifacts");

/**
 * Deterministic constant-frame-rate fixture: 20 frames at exactly 10 fps.
 * Frame ordinal k has PTS k * 100_000 microseconds.
 */
export const CFR_FIXTURE = {
	path: join(ARTIFACT_DIR, "cfr-10fps.mp4"),
	frameCount: 20,
	expectedPtsUs: Array.from({ length: 20 }, (_, k) => k * 100_000),
};

/**
 * Deterministic variable-frame-rate fixture. Built by selecting irregularly
 * spaced frames from a 30 fps source and re-muxing with passthrough timestamps,
 * so the container carries genuinely non-uniform PTS. Selected source ordinals:
 *   n = 0, 5, 7, 20, 45, 80  -> PTS n/30 s.
 * The average frame rate (45/7) does NOT match any real inter-frame spacing,
 * which is exactly why ordinal- or rate-derived timestamps drift on VFR input.
 */
export const VFR_FIXTURE = {
	path: join(ARTIFACT_DIR, "vfr-irregular.mp4"),
	frameCount: 6,
	// n/30 s in microseconds, matching ffmpeg's 6-decimal rendering.
	expectedPtsUs: [0, 5, 7, 20, 45, 80].map((n) => Math.round((n / 30) * 1e6)),
};

/**
 * Sub-500ms transient: a black 64x64 clip at 10 fps for 2s (20 frames) with a
 * white full-frame flash enabled only for t in [1.0, 1.3) — three frames, 0.3s.
 * The flash is a short high-change burst bounded by stability on both sides.
 */
export const TRANSIENT_FIXTURE = {
	path: join(ARTIFACT_DIR, "transient-flash.mp4"),
	frameCount: 20,
	flashOrdinals: [10, 11, 12],
};

/**
 * Long-static then a single hard cut: black for 2s (20 frames) then white for 1s
 * (10 frames), 10 fps. A long stable run precedes a global boundary at ordinal 20.
 */
export const STATIC_FIXTURE = {
	path: join(ARTIFACT_DIR, "long-static.mp4"),
	frameCount: 30,
	cutOrdinal: 20,
};

/**
 * Local animation: a small yellow box blinks on/off over a static navy
 * background, 64x64 at 10 fps for 2s (20 frames). Only a small region (12x12)
 * changes each frame — sustained localized motion, never a global cut.
 */
export const LOCAL_ANIMATION_FIXTURE = {
	path: join(ARTIFACT_DIR, "local-animation.mp4"),
	frameCount: 20,
};

/**
 * Scrolling content: a static grid pattern viewed through a vertically moving
 * crop window, 64x64 at 10 fps for 2s (20 frames). Most pixels shift each frame.
 */
export const SCROLL_FIXTURE = {
	path: join(ARTIFACT_DIR, "scroll.mp4"),
	frameCount: 20,
};

/**
 * Brief LOCALIZED transient: a small yellow box appears for exactly two frames
 * (ordinals 10–11) over an otherwise static navy background, 64x64 at 10 fps for
 * 2s (20 frames). The flash is local motion, not a global cut.
 */
export const LOCAL_TRANSIENT_FIXTURE = {
	path: join(ARTIFACT_DIR, "local-transient.mp4"),
	frameCount: 20,
	flashOrdinals: [10, 11],
};

/**
 * Sub-stride hidden transient: a full-frame white flash on exactly ONE odd frame
 * (ordinal 11) over black, 64x64 at 10 fps for 2s (20 frames). A stride-2 scan
 * samples only even ordinals, so the strided pass never sees the flash — the
 * degraded-policy full-cadence rescan must recover it.
 */
export const HIDDEN_TRANSIENT_FIXTURE = {
	path: join(ARTIFACT_DIR, "hidden-transient.mp4"),
	frameCount: 20,
	flashOrdinal: 11,
};

async function generateCfr(): Promise<void> {
	await execFileAsync(FFMPEG, [
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc=duration=2:size=64x64:rate=10",
		"-pix_fmt",
		"yuv420p",
		"-c:v",
		"libx264",
		CFR_FIXTURE.path,
	]);
}

async function generateVfr(): Promise<void> {
	await execFileAsync(FFMPEG, [
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc=duration=3:size=64x64:rate=30",
		"-vf",
		"select='eq(n\\,0)+eq(n\\,5)+eq(n\\,7)+eq(n\\,20)+eq(n\\,45)+eq(n\\,80)'",
		"-fps_mode",
		"passthrough",
		"-enc_time_base",
		"-1",
		"-c:v",
		"libx264",
		VFR_FIXTURE.path,
	]);
}

async function generateFromColorFilter(path: string, filter: string): Promise<void> {
	await execFileAsync(FFMPEG, [
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=c=black:s=64x64:d=2:r=10",
		"-vf",
		filter,
		"-pix_fmt",
		"yuv420p",
		"-c:v",
		"libx264",
		path,
	]);
}

async function generateTransient(): Promise<void> {
	// White full-frame flash for t in [1.0, 1.3): ordinals 10, 11, 12.
	await generateFromColorFilter(
		TRANSIENT_FIXTURE.path,
		"drawbox=x=0:y=0:w=64:h=64:color=white:t=fill:enable='between(t\\,1.0\\,1.3)'",
	);
}

async function generateStatic(): Promise<void> {
	// 3s (30 frames): black then a hard cut to white at t>=2 (ordinal 20).
	await execFileAsync(FFMPEG, [
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=c=black:s=64x64:d=3:r=10",
		"-vf",
		"drawbox=x=0:y=0:w=64:h=64:color=white:t=fill:enable='gte(t\\,2.0)'",
		"-pix_fmt",
		"yuv420p",
		"-c:v",
		"libx264",
		STATIC_FIXTURE.path,
	]);
}

async function generateLocalAnimation(): Promise<void> {
	// A small yellow box blinks on even frames over a static navy background:
	// a localized 12x12 change each frame, never a global cut.
	await execFileAsync(FFMPEG, [
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=c=navy:s=64x64:d=2:r=10",
		"-vf",
		"drawbox=x=6:y=6:w=12:h=12:color=yellow:t=fill:enable='eq(mod(n\\,2)\\,0)'",
		"-pix_fmt",
		"yuv420p",
		"-c:v",
		"libx264",
		LOCAL_ANIMATION_FIXTURE.path,
	]);
}

async function generateScroll(): Promise<void> {
	// A static 64x128 grid viewed through a vertically moving 64x64 crop window.
	await execFileAsync(FFMPEG, [
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=c=gray:s=64x128:d=2:r=10",
		"-vf",
		"drawgrid=w=8:h=8:t=1:c=white,crop=64:64:0:'mod(floor(t*10)*5\\,64)'",
		"-pix_fmt",
		"yuv420p",
		"-c:v",
		"libx264",
		SCROLL_FIXTURE.path,
	]);
}

async function generateLocalTransient(): Promise<void> {
	// A small yellow box appears only on frames 10–11 over a static navy background.
	await execFileAsync(FFMPEG, [
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=c=navy:s=64x64:d=2:r=10",
		"-vf",
		"drawbox=x=6:y=6:w=12:h=12:color=yellow:t=fill:enable='between(n\\,10\\,11)'",
		"-pix_fmt",
		"yuv420p",
		"-c:v",
		"libx264",
		LOCAL_TRANSIENT_FIXTURE.path,
	]);
}

async function generateHiddenTransient(): Promise<void> {
	// Full-frame white flash on exactly one odd frame (n=11) over black.
	await generateFromColorFilter(
		HIDDEN_TRANSIENT_FIXTURE.path,
		"drawbox=x=0:y=0:w=64:h=64:color=white:t=fill:enable='eq(n\\,11)'",
	);
}

let generated: Promise<void> | undefined;

/** Generate the deterministic FFmpeg fixtures once per test process. */
export function ensureFixtures(): Promise<void> {
	if (!generated) {
		generated = (async () => {
			mkdirSync(ARTIFACT_DIR, { recursive: true });
			if (!existsSync(CFR_FIXTURE.path)) await generateCfr();
			if (!existsSync(VFR_FIXTURE.path)) await generateVfr();
			if (!existsSync(TRANSIENT_FIXTURE.path)) await generateTransient();
			if (!existsSync(STATIC_FIXTURE.path)) await generateStatic();
			if (!existsSync(LOCAL_ANIMATION_FIXTURE.path)) await generateLocalAnimation();
			if (!existsSync(SCROLL_FIXTURE.path)) await generateScroll();
			if (!existsSync(LOCAL_TRANSIENT_FIXTURE.path)) await generateLocalTransient();
			if (!existsSync(HIDDEN_TRANSIENT_FIXTURE.path)) await generateHiddenTransient();
		})();
	}
	return generated;
}
