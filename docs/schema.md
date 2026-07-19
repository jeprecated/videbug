# Report schema (`AnalysisResultV1`)

The `--format json` output is a single `AnalysisResultV1` object. JSON is the
canonical representation; the Markdown renderer is a pure function over a validated
value of this shape.

- **Canonical contract (source of truth):** `src/contracts/analysis-v1.ts` (TypeBox).
- **Machine-readable JSON Schema (draft-07):**
  [`schema/analysis-result.v1.schema.json`](../schema/analysis-result.v1.schema.json),
  derived deterministically from the TypeBox contract by `npm run schema:export`.
- **Drift protection:** `tests/contracts/json-schema.test.ts` fails if the tracked
  schema file diverges from the contract, so the exported schema can never silently
  fall out of sync.

## Versioning

- `schemaVersion` is the literal string **`"1"`**. A breaking change to the report
  shape bumps this to a new value and ships a new schema file
  (`analysis-result.vN.schema.json`); the `$id` encodes the version.
- Additive, backward-compatible fields may be introduced within version `1`; consumers
  should ignore unknown fields.

## Top-level shape

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | `"1"` | Pinned literal. |
| `status` | `"complete"` \| `"partial"` | `partial` ⇒ a validated structured result was submitted with honest uncovered ranges after an actual inspection constraint; exit 5. Provider/timeout aborts normally produce no payload. |
| `coverage` | object | `analyzedStartMs`, `analyzedEndMs`, `uninspectedRanges[]`, `confidence`. Runtime-owned. |
| `summary` | object | `observedFailure`, `chronology`. |
| `beats[]` | array | Ordered debug beats (see below). |
| `anomalies[]` | array | Categorized findings (see below). |
| `handoff` | object | `reproductionSteps[]`, `suggestedInvestigations[]`, `uncertainties[]`. |
| `source` | object | **Deterministic**, CLI-injected fingerprint. |
| `provenance` | object | **Deterministic**, CLI-injected run provenance. |

The `source` and `provenance` blocks are **never supplied by the model** — the CLI
derives them from the file, the frame catalog, and runtime state and injects them into
the validated payload.

## Debug beats

```jsonc
{
  "id": "B12",                       // ^B\d+$
  "time": { "startMs": 43500, "endMs": 43750, "precisionMs": 100 },
  "kind": "state",                   // state | transition | transient
  "observation": {
    "summary": "…",                  // direct observation
    "visibleText": ["…"],            // text read from the frame
    "motion": "none"                 // none | local-animation | scroll | global-transition | unknown
  },
  "transitionFromPrevious": "…",     // optional
  "evidence": [ /* citations */ ],
  "confidence": "high",              // high | medium | low
  "inferences": [ { "statement": "…", "basis": "inference" } ]
}
```

Direct observation and inference are kept in separate fields: `observation` is what is
visible; anything not directly visible must be labelled `inferences[]` (or an anomaly's
`inference`/`uncertainties`).

## Evidence citations (the integrity core)

```jsonc
{ "frameId": "v0_f000000657_p000043600_2c91a7", "ptsMs": 43600, "role": "representative" }
```

- `frameId` encodes provenance: stream index, zero-padded frame ordinal, **PTS in
  milliseconds**, and a short content digest, e.g.
  `v{stream}_f{ordinal(9)}_p{ptsMs(9)}_{digest(6)}`. Fixed-width fields make lexical
  order match chronological order.
- **Validation:** the PTS embedded in `frameId` must exactly equal the sibling `ptsMs`,
  and `ptsMs` must lie within the source duration. A mismatch, malformed id, or
  out-of-range PTS fails validation — timestamps cannot be invented or rounded.
- `role`: `representative` | `before` | `after` | `boundary` | `text-detail`. A single
  frame reused as the `representative` of two distinct beats is rejected as duplicated
  independent evidence.

## Anomalies

```jsonc
{
  "category": "contradictory-state",  // loading | contradictory-state | persistent-overlay
                                      // | failed-action | incremental-render | navigation | other
  "severity": "warning",              // info | warning | error
  "description": "…",
  "whySuspicious": "…",
  "beatIds": ["B19", "B20"],          // must resolve to declared beats
  "evidence": [ /* citations */ ],
  "inference": "…",                    // optional; root-cause guesses live here, not in description
  "confidence": "medium",
  "uncertainties": ["…"]
}
```

Root-cause claims belong in `inference`/`uncertainties`, not in `description` — an
unsupported causal claim in the asserted text is a quality defect.

## Determinism notes

- Timestamps come from the source frame catalog, never from output filenames or
  sample cadence.
- `coverage.uninspectedRanges` is computed from runtime inspection state; a `complete`
  status with any canonical uncovered segment is rejected, and a `partial` must list
  every uncovered segment.
