# Architecture & security boundaries

`videbug` is a one-call CLI with two cooperating layers: a **deterministic
evidence engine** and a **constrained vision-agent orchestration**. The engine
establishes trustworthy, source-PTS-accurate evidence; the agents provide semantic
judgment over that evidence and can never manufacture timing.

> For an end-to-end walkthrough with worked examples (and why the allowance numbers are
> a worst-case ceiling, not work sent), see [`how-it-works.md`](how-it-works.md).

## Pipeline

```
video ─▶ probe (ffprobe)             deterministic frame catalog (PTS, CFR/VFR)
      ─▶ fingerprint (sha256)        source identity
      ─▶ bounded streaming scan      low-res every-frame change signals
      ─▶ change signals + candidates boundary / transient / stable / local-animation windows
      ─▶ evidence registry           exact extraction, stable evidence IDs, budgets
      ─▶ analyst session (Pi)        inspect_* tools + submit_analysis  ── validated
      ─▶ reviewer session (Pi)       fresh, independent  submit_review  ── accept | replace
      ─▶ validated AnalysisResultV1  Markdown/JSON to sibling file, --output, or --stdout
```

Every stage fails closed: count, PTS, duplicate, ordering, citation, schema, coverage,
budget, and review failures are explicit exit codes, never silently patched.

## Deterministic evidence engine (`src/video`, `src/evidence`, `src/app`)

- **Probe & catalog:** `ffprobe` yields the authoritative per-frame PTS catalog;
  rational time bases are converted exactly. CFR and VFR are both supported; a
  count/PTS mismatch against the catalog fails closed (exit 3).
- **Fingerprint:** the source sha256 identifies the recording and binds the report to
  it.
- **Streaming scan:** raw frames are processed with bounded-memory backpressure (no
  whole-output buffering) into per-frame change signals. A degraded scan triggers an
  adaptive full-cadence recovery so brief transients are not lost.
- **Candidates:** change signals are grouped into targetable windows (boundary,
  transient, stable, local-animation). Frame-sized PTS gaps get tolerance so adjacent
  inspected ranges do not create false uncovered slivers.
- **Evidence registry:** extraction preserves source PTS; each frame gets a stable
  evidence ID (`v{stream}_f{ordinal}_p{ptsMs}_{digest}`) whose embedded PTS is the
  citation contract. Contact sheets are rendered with a **bundled** monospace font so
  labels are authoritative (not the blank-glyph failure other tools hit).
- **Allowances (auto-coverage):** production runs derive a **generous per-video
  allowance** (`coverage-allowance.ts`) from deterministic complexity, sized to complete
  every mandatory window, every ≥5 s gap, and refinement/full-res obligations. The
  per-session `BudgetLedger` still enforces atomic, fail-closed limits on ranges,
  overviews, cells, full-resolution frames, and comparisons — now as **runaway guards
  and usage telemetry**, not an arbitrary evaluation cap. The frozen 12/250/12 +
  historical reviewer-half budgets remain the minimums, and are pinned only for evaluation
  reproducibility via `VTD_FIXED_BUDGETS=1`. Provenance reports **actual** spend.
- **Coverage honesty:** the runtime — not the model — owns which mandatory windows and
  large gaps remain uncovered; a submission cannot lie about coverage in either
  direction.

## Constrained agent orchestration (`src/agent`)

- **Isolation:** each session is built from the user's Pi auth/registry but runs with
  overridden system/append prompts and **only** the allowlisted vision tools. It does
  **not** discover unrelated project tools, context, shell, filesystem, or network.
- **Tools exposed:** `inspect_overview`, `inspect_range`, `inspect_frame`,
  `compare_evidence`, `get_inspection_status`, and the structured `submit_analysis` /
  `submit_review`. Nothing else.
- **Structured submissions only:** results are captured from the immutable
  `submit_*` payloads. Assistant prose is never scraped, and a schema-invalid or
  citation-invalid submission triggers exactly one bounded repair turn, then fails
  closed (exit 6).
- **Independent reviewer (standard mode):** a fresh session with no analyst transcript,
  its own independently auto-sized ledger, and a candidate summary + evidence access. It may **accept
  unchanged** or submit a **complete replacement** — never a patch. Both verdict paths validate the
  selected payload against reviewer-live coverage and allowance, so `accept` cannot bypass unfinished
  range or full-resolution obligations. A rejection without a valid replacement is exit 7.
- **Model gates:** the analyst/reviewer model must resolve, accept images, and have
  configured auth, or the run fails closed (exit 4) before any provider call.

## Trust boundaries

| Boundary | Rule |
|---|---|
| Video pixels / visible text | **Untrusted data.** Potential prompt injection; treated as evidence to describe, never as instructions to follow. |
| Model output | **Untrusted claims.** Only structured, schema- and citation-validated `submit_*` payloads are accepted; timing is bound to real source PTS. |
| Source / provenance fields | **Deterministic, CLI-owned.** Injected from the file and runtime; the model cannot set them. |
| Coverage completeness | **Runtime-owned.** Derived from inspection state, not model assertion. |
| Secrets / credentials | Read via the Pi SDK auth storage; never logged, echoed, or persisted into reports/manifests. |

## Data handling & privacy

- Only selected frames (contact-sheet cells + explicitly requested full-resolution
  frames) leave the machine, to the configured model provider. The full video is never
  uploaded.
- Temporary workspaces are `0700`/`0600`, created under a private directory, and
  removed on success, failure, timeout, or SIGINT. `--keep-artifacts` opts out for
  tool debugging.
- No reasoning, chain-of-thought, transcripts, or tool payload dumps are persisted.
  The run manifest (`--keep-artifacts`) holds only counts, budgets, inspected ranges,
  model ids, and verdicts.
- The final report uses a sibling file by default and is `0600` for all file
  destinations, written atomically (temp file + rename) with cleanup of the temp file
  on write/rename failure. `--stdout` is available for agent/pipeline consumption.

## Cancellation & resource safety

A wall-clock `--timeout` and SIGINT both abort through a single `AbortSignal` forwarded
into the pipeline, which kills ffmpeg children and removes the private workspace before
exit. Partial results are retained by file destinations (never stdout) with exit 5.

## Determinism vs. model variance

The deterministic engine is fully unit-tested (rational time bases, catalog
monotonicity, diff/hash/motion grids, candidate selection, extraction mapping and
duplicate detection, registry authorization, budget accounting, schema/semantic
validation, Markdown snapshots, timeout/cancellation/cleanup, CLI exit behavior).
Model quality should be assessed with versioned recordings and frozen references,
never a brittle one-off assertion.
