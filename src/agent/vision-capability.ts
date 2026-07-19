/**
 * Vision capability check.
 *
 * Pi models expose `input: ("text" | "image")[]`. A model can only receive the
 * contact sheets and full-resolution frames this system depends on if that array
 * includes "image". The CLI must fail closed (exit code 4) when the selected
 * model cannot accept images, rather than silently producing a text-only run.
 */

/** Minimal structural view of a Pi model needed for the capability check. */
export interface VisionCapableModelLike {
	readonly input: readonly ("text" | "image")[];
}

export interface IdentifiableModelLike extends VisionCapableModelLike {
	readonly provider?: string;
	readonly id?: string;
}

export class VisionModelError extends Error {
	readonly provider: string | undefined;
	readonly modelId: string | undefined;

	constructor(model: IdentifiableModelLike) {
		const label = model.provider && model.id ? `${model.provider}/${model.id}` : "the selected model";
		super(`${label} cannot accept images (input: ${JSON.stringify(model.input)}). A vision-capable model is required.`);
		this.name = "VisionModelError";
		this.provider = model.provider;
		this.modelId = model.id;
	}
}

export function isVisionCapable(model: VisionCapableModelLike): boolean {
	return model.input.includes("image");
}

export function assertVisionCapable<T extends IdentifiableModelLike>(model: T): T {
	if (!isVisionCapable(model)) throw new VisionModelError(model);
	return model;
}
