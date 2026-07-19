# ADR 0001 — M0 feasibility spikes and frozen contracts

Status: accepted (M0)
Date: 2026-07-15
Scope: the initial contract and feasibility milestone.

M0 resolves the four highest-risk unknowns before substantial implementation
(implementation plan §18 gates 1–4) and freezes the initial result and CLI
contracts. This ADR records the decisions and the evidence behind them. Nothing
here commits later product milestones.

## Context

The plan depends on four things being true:

1. the Pi SDK 0.80.7 can run an isolated, in-memory session that exposes only
   custom tools;
2. a custom tool can deliver image content to a vision-capable model;
3. a schema-valid structured submission can be captured without parsing prose,
   ideally terminating the turn on the tool call;
4. exact source-frame PTS extraction is achievable on both CFR and VFR input
   without duplicates or ordinal drift.

The Pi SDK is version 0.80.7 (scope `@earendil-works/pi-*`).

## Decision 1 — Exact Pi SDK pin as a normal npm dependency

> **Updated in M1.** The SDK is now published to the public npm registry
> (`npm view @earendil-works/pi-coding-agent@0.80.7` succeeds). The original M0
> Nix-store link workaround — and its now-false claim that the package "is not
> published to the public npm registry" — have been removed.

The Pi SDK is consumed as an **exact, lockfile-pinned normal dependency**:

- `package.json` lists `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`
  at exact `0.80.7`, plus `typebox` at exact `1.1.38` (the SDK's own typebox
  version, deduped so our schemas and the SDK share one instance). `pi-ai` is a
  direct dependency because our source imports it directly; the remaining
  `@earendil-works/*` packages resolve as transitive dependencies.
- `package-lock.json` pins every resolved version with an integrity hash, so the
  pin is genuinely reproducible without any machine-specific store path.
- `scripts/link-pi-sdk.mjs`, the `postinstall`/`link-pi-sdk` scripts, the
  `package.json#piSdk` workaround field, and the `PI_CODING_AGENT_STORE` Devenv
  env var are all deleted. `devenv.nix` restores the SDK with `npm install`.

Rationale: the package is now portable via the public registry, so an exact
lockfile-pinned dependency is both simpler and genuinely reproducible, and
removes the machine-specific Nix-store coupling.

Operational note (host npm policy): this machine enforces a NixOS-managed
`min-release-age=7` supply-chain policy. Version `0.80.7` was published ~2 days
before this change, so a clean `npm install` on this host requires the pin to age
past the 7-day window (a plain `npm install` against an already-satisfied
lockfile is a no-op and is not gated). This is a host policy, not a property of
the package; the exact pin plus lockfile integrity is the supply-chain control.

## Decision 2 — Isolated, in-memory, vision-only session factory

`src/agent/session.ts#createIsolatedVisionSession` builds the session with:

- `noTools: "all"` plus an explicit `customTools` allowlist and `tools` naming
  only those custom tools → **no built-in coding tools** (`read`, `bash`, `edit`,
  `write`, `grep`, `find`, `ls`);
- `SessionManager.inMemory()` and `SettingsManager.inMemory({ compaction: { enabled: false } })`;
- a `DefaultResourceLoader` with `systemPromptOverride: () => systemPrompt` and
  `appendSystemPromptOverride: () => []` so unrelated user/project append prompts
  cannot enter the analysis session;
- a fail-closed `assertVisionCapable` check (`model.input.includes("image")`)
  before the session is built.

This contract is proven **offline** in `tests/agent/session-isolation.test.ts`: a
built-in vision model resolves from `ModelRegistry.inMemory` without auth, the
session exposes exactly `["inspect_frame", "submit_analysis"]`, and the system
prompt override is applied — with no network call and no `prompt()`.

## Decision 3 — Structured submit capture with `terminate: true`

`src/agent/tools/submit-analysis-tool.ts` validates the submitted
`AnalysisResultV1` semantic payload and, on success, stores an immutable copy in
a closure the CLI observes (`getResult()`). Invalid submissions return concrete
repair errors as tool content and do **not** set the latch. The CLI never parses
assistant prose.

`AgentToolResult.terminate?: boolean` is a **documented, type-checked field** in
Pi SDK 0.80.7 (`@earendil-works/pi-agent-core` `types.d.ts`; see
`examples/extensions/structured-output.ts`). A valid submission returns
`terminate: true`, ending the turn on the tool call without an extra assistant
round-trip. **No prose-stop fallback is required.** The image tool
(`inspect_frame`) returns `ImageContent` (`{ type: "image", data, mimeType }`)
and can only resolve registered frame IDs — it has no arbitrary path access.

## Decision 4 — Exact extraction: `select=eq(n,…)` + `-fps_mode passthrough`, verified by `showinfo`

`src/video/probe.ts` builds a source-PTS frame catalog from ffprobe's
`best_effort_timestamp_time`, normalized to integer microseconds, and rejects a
non-monotonic catalog. `src/video/extract.ts` extracts requested ordinals with
`select=eq(n,<ordinal>)+…` and `-fps_mode passthrough` (never a
constant-output-frame-rate pipeline). The authoritative per-output PTS is read
from the `showinfo` filter log — **not** from output filenames — and
`verifyExtraction` fails closed on any count mismatch, duplicate PTS, ordering
regression, or ordinal→PTS drift.

Evidence (`tests/video/*.test.ts`, deterministic CFR and VFR fixtures generated
by ffmpeg):

- CFR (10 fps): all 20 frame PTS recovered exactly; extracting ordinals `[0,5,19]`
  yields PTS `[0, 500000, 1900000]` µs.
- VFR (irregular PTS from a 30 fps source, `avg_frame_rate = 45/7`): frame PTS
  recovered exactly (`[0, 166667, 233333, 666667, 1500000, 2666667]` µs); the
  catalog PTS explicitly does not match the rate-derived timestamp, proving no
  ordinal/rate drift.
- `verifyExtraction` fails closed on count mismatch, duplicated output PTS, and
  ordinal→PTS drift.

Rejected alternatives: ordinal-based filename pairing without independent
count/PTS checks (preventing synthetic timing and frame-association failures);
any `-r`/CFR output pipeline.

## Initial contracts (frozen for M0)

- `src/contracts/analysis-v1.ts` defines the initial `AnalysisResultV1` **submit
  payload** (the semantic fields the analyst submits; deterministic `source` and
  `provenance` are injected by the CLI and excluded here) as a typebox schema plus
  `validateSubmitPayload`, which returns structured errors instead of throwing.
  (M1 update: the complete `AnalysisResultV1` schema with injected
  `source`/`provenance`, the comprehensive semantic/citation validator
  `contracts/validation.ts`, and the JSON/Markdown renderers now exist.)
- CLI contract: the surface, defaults, and exit codes in implementation plan §4
  are the frozen M0 CLI contract ADR; no CLI is built in M0.

## Residual risks

- **R1** (resolved in M1): The Pi SDK is now on the public npm registry and is
  consumed as an exact, lockfile-pinned normal dependency. The Nix-store link
  workaround and its false "not published" claim are removed. Residual: on hosts
  with an `npm min-release-age` policy, a clean install of a just-published
  version may need the pin to age past that window.
- **R2**: Fixtures are generated by the Devenv-pinned ffmpeg (8.1.1). A different
  ffmpeg could in principle change container timestamps; tests assert against
  independently-known construction PTS, so drift would surface as a failure.
- **R3**: The live smoke test (`tests/live/analyst-smoke.test.ts`) requires
  `V2D_LIVE=1` and Pi auth and is not a CI gate; it exercises real image
  transport and structured capture.
- **R4**: A pinned Node in Devenv is added, but the current session validated with
  the system Node 24 toolchain; a fresh `devenv shell` should be used to confirm
  the pinned Node path.
