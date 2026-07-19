import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Fixed-message wrapper for failures involving a user-requested output/artifact
 * path. The raw Node/ffmpeg error remains available only as `cause`; CLI rendering
 * prints this outer message and therefore cannot echo credentials or unrelated
 * filesystem context embedded in the requested path.
 */
export class RequestedPathError extends Error {
	constructor(message: string, cause: unknown) {
		super(message, { cause });
		this.name = "RequestedPathError";
	}
}

export async function ensureRequestedArtifactsDirectory(dir: string): Promise<void> {
	try {
		await mkdir(dir, { recursive: true });
	} catch (error) {
		throw new RequestedPathError("Unable to create the requested artifacts directory.", error);
	}
}

export async function writeRequestedArtifact(path: string, contents: string): Promise<void> {
	try {
		await writeFile(path, contents, "utf8");
	} catch (error) {
		throw new RequestedPathError("Unable to write requested analysis artifacts.", error);
	}
}

/**
 * Evidence extraction runs inside the requested artifacts directory. Sanitize an
 * outward error only when its rendered message contains that requested path (as
 * supplied or resolved); unrelated model/source failures retain their normal type.
 */
export function sanitizeRequestedArtifactsFailure(error: unknown, dir: string): unknown {
	if (!(error instanceof Error)) return error;
	const supplied = dir;
	const absolute = resolve(dir);
	if ((supplied.length > 0 && error.message.includes(supplied)) || error.message.includes(absolute)) {
		return new RequestedPathError("Unable to use the requested artifacts directory.", error);
	}
	return error;
}
