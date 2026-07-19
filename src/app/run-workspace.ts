import { chmodSync } from "node:fs";
/**
 * Private per-run workspace with guaranteed cleanup (implementation plan §11–12).
 *
 * Every run gets a fresh, user-only (0700) temporary directory that holds decoded
 * frames, sheets, and manifests. It is removed on every exit path — success,
 * error, or cancellation — so sensitive frame contents never persist by default.
 * `withRunWorkspace` guarantees cleanup in a `finally` block; a raw
 * `createRunWorkspace` caller must call `cleanup()` itself (ideally in `finally`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunWorkspace {
	/** Absolute path to the private workspace root. */
	readonly dir: string;
	/** Resolve a path under the workspace root. */
	path(...segments: string[]): string;
	/** Recursively remove the workspace. Idempotent and never throws on absence. */
	cleanup(): Promise<void>;
}

const PREFIX = "videbug-";

export async function createRunWorkspace(prefix: string = PREFIX): Promise<RunWorkspace> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	// mkdtemp already creates 0700 on POSIX, but enforce it explicitly so the
	// user-only guarantee does not silently depend on the platform default umask.
	chmodSync(dir, 0o700);

	let cleaned = false;
	return {
		dir,
		path: (...segments: string[]) => join(dir, ...segments),
		cleanup: async () => {
			if (cleaned) return;
			cleaned = true;
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/**
 * Run `fn` with a fresh private workspace and guarantee cleanup, even if `fn`
 * throws or the run is cancelled. Returns whatever `fn` returns.
 */
export async function withRunWorkspace<T>(
	fn: (workspace: RunWorkspace) => Promise<T>,
	prefix: string = PREFIX,
): Promise<T> {
	const workspace = await createRunWorkspace(prefix);
	try {
		return await fn(workspace);
	} finally {
		await workspace.cleanup();
	}
}
