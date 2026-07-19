/**
 * Resolve the tool version from package.json.
 *
 * Both the source layout (`src/util/version.ts`) and the built layout
 * (`dist/util/version.js`) resolve `../../package.json` to the project root, so
 * this works under vitest/tsx and from the compiled CLI alike.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

export function readToolVersion(): string {
	if (cached !== undefined) return cached;
	const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
	cached = JSON.parse(readFileSync(pkgPath, "utf8")).version as string;
	return cached;
}
