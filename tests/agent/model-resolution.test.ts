import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	assertModelAuthorized,
	resolveAnalystModel,
	resolveDefaultModel,
	resolveModelReference,
} from "../../src/agent/model-resolution.ts";
import { PiUnavailableError } from "../../src/util/errors.ts";

// Offline: resolution and the vision-capability gate use ModelRegistry.getAll(),
// which needs no auth. The auth gate is tested separately with a stub registry so
// no provider credentials are required.
const authStorage = AuthStorage.create(join(mkdtempSync(join(tmpdir(), "vtd-model-")), "auth.json"));
const registry = ModelRegistry.inMemory(authStorage);

// Real built-in Model objects, used to build deterministic fake registries below.
const catalog = registry.getAll();
const sol = catalog.find((m) => m.provider === "openai-codex" && m.id === "gpt-5.6-sol");
const terra = catalog.find((m) => m.provider === "openai-codex" && m.id === "gpt-5.6-terra");
const textOnly = catalog.find((m) => !m.input.includes("image"));
if (!sol || !terra || !textOnly) throw new Error("expected built-in models for the offline model-resolution tests");

/**
 * Deterministic structural registry: `getAvailable()` returns the authenticated
 * (auth-configured) set, `find()`/`getAll()` search the whole catalog, and
 * `hasConfiguredAuth()` is membership in the available set by provider/id. This is
 * enough for both the real SDK scope resolver (which only calls `getAvailable()`)
 * and our selection logic, without any credentials or network.
 */
function fakeRegistry(opts: { available?: Model<Api>[]; catalog?: Model<Api>[] }): ModelRegistry {
	const available = opts.available ?? [];
	const all = opts.catalog ?? [...available];
	return {
		getAll: () => all,
		getAvailable: () => available,
		find: (provider: string, id: string) => all.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (m: Model<Api>) => available.some((a) => a.provider === m.provider && a.id === m.id),
	} as unknown as ModelRegistry;
}

/** A merged-settings view built from the real SDK SettingsManager (offline, in-memory). */
function settingsView(input: {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	enabledModels?: string[];
}): NonNullable<Parameters<typeof resolveDefaultModel>[1]> {
	return SettingsManager.inMemory(
		input as unknown as Parameters<typeof SettingsManager.inMemory>[0],
	) as unknown as NonNullable<Parameters<typeof resolveDefaultModel>[1]>;
}

describe("resolveModelReference", () => {
	it("resolves a CLI provider/model reference to a vision-capable model", () => {
		const resolved = resolveModelReference(registry, "anthropic/claude-opus-4-8");
		expect(resolved.model.provider).toBe("anthropic");
		expect(resolved.model.id).toBe("claude-opus-4-8");
		expect(resolved.model.input).toContain("image");
	});

	it("parses an explicit thinking level suffix", () => {
		const resolved = resolveModelReference(registry, "anthropic/claude-opus-4-8:high");
		expect(resolved.thinkingLevel).toBe("high");
	});

	it("fails closed (exit 4) for an unresolvable reference", () => {
		try {
			resolveModelReference(registry, "nope/does-not-exist");
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(PiUnavailableError);
			expect((error as PiUnavailableError).exitCode).toBe(4);
		}
	});

	it("fails closed (exit 4) when the resolved model cannot accept images", () => {
		const ref = `${textOnly.provider}/${textOnly.id}`;
		try {
			resolveModelReference(registry, ref);
			throw new Error("expected throw");
		} catch (error) {
			expect(error).toBeInstanceOf(PiUnavailableError);
			expect((error as PiUnavailableError).exitCode).toBe(4);
			expect((error as Error).message).toMatch(/image/i);
		}
	});
});

describe("resolveDefaultModel (no --model: Pi enabled/default model semantics)", () => {
	it("selects the first enabled model when the saved default is stale/not in scope (cursor + [sol,terra] => sol)", async () => {
		// The reported regression: stale saved default `cursor/gpt-5.5@272k` that no
		// longer resolves, plus enabledModels [sol, terra]. Pi selects the first
		// scoped model (sol). Uses the REAL SDK scope resolver over a fake registry.
		const reg = fakeRegistry({ available: [sol, terra] });
		const settings = settingsView({
			defaultProvider: "cursor",
			defaultModel: "gpt-5.5@272k",
			defaultThinkingLevel: "high",
			enabledModels: ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-terra"],
		});
		const resolved = await resolveDefaultModel(reg, settings);
		expect(`${resolved.model.provider}/${resolved.model.id}`).toBe("openai-codex/gpt-5.6-sol");
		// Enabled entry carries no explicit thinking → settings default thinking applies.
		expect(resolved.thinkingLevel).toBe("high");
	});

	it("prefers the saved default when it is an authenticated member of the enabled scope (terra => terra)", async () => {
		const reg = fakeRegistry({ available: [sol, terra] });
		const settings = settingsView({
			defaultProvider: "openai-codex",
			defaultModel: "gpt-5.6-terra",
			enabledModels: ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-terra"],
		});
		const resolved = await resolveDefaultModel(reg, settings);
		expect(`${resolved.model.provider}/${resolved.model.id}`).toBe("openai-codex/gpt-5.6-terra");
	});

	it("uses an explicit thinking level from the enabled pattern over the settings default", async () => {
		const reg = fakeRegistry({ available: [sol, terra] });
		const settings = settingsView({
			defaultThinkingLevel: "high",
			enabledModels: ["openai-codex/gpt-5.6-sol:low", "openai-codex/gpt-5.6-terra"],
		});
		const resolved = await resolveDefaultModel(reg, settings);
		expect(`${resolved.model.provider}/${resolved.model.id}`).toBe("openai-codex/gpt-5.6-sol");
		expect(resolved.thinkingLevel).toBe("low");
	});

	it("falls back to an authenticated vision model when every enabled pattern is invalid (diagnostics path)", async () => {
		const reg = fakeRegistry({ available: [textOnly, sol] });
		const settings = settingsView({ enabledModels: ["does-not-exist-xyz"] });
		const resolved = await resolveDefaultModel(reg, settings);
		expect(`${resolved.model.provider}/${resolved.model.id}`).toBe(`${sol.provider}/${sol.id}`);
	});

	it("fails closed (exit 4) without substitution when the FIRST enabled model is text-only", async () => {
		// Pi would select the first scoped model; this app requires images, so it
		// fails closed rather than silently skipping to the vision-capable sol.
		const reg = fakeRegistry({ available: [textOnly, sol] });
		const settings = settingsView({
			enabledModels: [`${textOnly.provider}/${textOnly.id}`, "openai-codex/gpt-5.6-sol"],
		});
		const error = await resolveDefaultModel(reg, settings).catch((e) => e);
		expect(error).toBeInstanceOf(PiUnavailableError);
		expect((error as PiUnavailableError).exitCode).toBe(4);
		expect((error as Error).message).toMatch(/image/i);
	});

	it("uses an exact authenticated saved default when no enabled scope is configured", async () => {
		const reg = fakeRegistry({ available: [sol] });
		const settings = settingsView({ defaultProvider: "openai-codex", defaultModel: "gpt-5.6-sol" });
		const resolved = await resolveDefaultModel(reg, settings);
		expect(`${resolved.model.provider}/${resolved.model.id}`).toBe(`${sol.provider}/${sol.id}`);
	});

	it("falls back to the first available vision model when there is no saved default or scope", async () => {
		const reg = fakeRegistry({ available: [textOnly, sol] });
		const resolved = await resolveDefaultModel(reg, null);
		expect(resolved.model.input).toContain("image");
		expect(`${resolved.model.provider}/${resolved.model.id}`).toBe(`${sol.provider}/${sol.id}`);
	});

	it("fails closed (exit 4) when no Pi model has configured auth", async () => {
		const reg = fakeRegistry({ available: [] });
		const error = await resolveDefaultModel(reg, null).catch((e) => e);
		expect(error).toBeInstanceOf(PiUnavailableError);
		expect((error as PiUnavailableError).exitCode).toBe(4);
	});

	it("fails closed (exit 4) when the available fallback models cannot accept images", async () => {
		const reg = fakeRegistry({ available: [textOnly] });
		const error = await resolveDefaultModel(reg, null).catch((e) => e);
		expect(error).toBeInstanceOf(PiUnavailableError);
		expect((error as Error).message).toMatch(/image/i);
	});
});

describe("resolveAnalystModel", () => {
	it("mirrors Pi enabled/default selection for the stale cursor + [sol,terra] case (=> sol)", async () => {
		const reg = fakeRegistry({ available: [sol, terra] });
		const settings = settingsView({
			defaultProvider: "cursor",
			defaultModel: "gpt-5.5@272k",
			defaultThinkingLevel: "high",
			enabledModels: ["openai-codex/gpt-5.6-sol", "openai-codex/gpt-5.6-terra"],
		});
		const resolved = await resolveAnalystModel({ authStorage, modelRegistry: reg, settings });
		expect(`${resolved.model.provider}/${resolved.model.id}`).toBe("openai-codex/gpt-5.6-sol");
		expect(resolved.thinkingLevel).toBe("high");
	});

	it("keeps explicit --model as the highest priority over the enabled/default selection", async () => {
		const reg = fakeRegistry({
			available: [sol, terra, resolveModelReference(registry, "anthropic/claude-opus-4-8").model],
		});
		const settings = settingsView({ enabledModels: ["openai-codex/gpt-5.6-sol"] });
		const resolved = await resolveAnalystModel({
			authStorage,
			modelRegistry: reg,
			settings,
			model: "anthropic/claude-opus-4-8",
		});
		expect(`${resolved.model.provider}/${resolved.model.id}`).toBe("anthropic/claude-opus-4-8");
	});

	it("falls back to the first available vision model when no settings are readable", async () => {
		const reg = fakeRegistry({ available: [sol] });
		const resolved = await resolveAnalystModel({ authStorage, modelRegistry: reg, settings: null });
		expect(resolved.model.input).toContain("image");
	});
});

describe("assertModelAuthorized", () => {
	it("throws PiUnavailableError when a model has no configured auth", () => {
		const model = resolveModelReference(registry, "anthropic/claude-opus-4-8").model;
		const stub = { hasConfiguredAuth: () => false } as unknown as ModelRegistry;
		expect(() => assertModelAuthorized(stub, model)).toThrow(PiUnavailableError);
	});

	it("passes when auth is configured", () => {
		const model = resolveModelReference(registry, "anthropic/claude-opus-4-8").model;
		const stub = { hasConfiguredAuth: () => true } as unknown as ModelRegistry;
		expect(() => assertModelAuthorized(stub, model)).not.toThrow();
	});
});
