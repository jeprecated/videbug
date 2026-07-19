/**
 * Recursively freeze a value so it cannot be mutated after capture.
 *
 * Used at trust boundaries (e.g. the accepted analysis latch) so a captured,
 * validated result cannot be altered by later code or by continued mutation of a
 * shared input object. Callers should clone first (`structuredClone`) when the
 * source is externally owned.
 */
export function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const key of Object.keys(value as Record<string, unknown>)) {
		deepFreeze((value as Record<string, unknown>)[key]);
	}
	return value;
}
