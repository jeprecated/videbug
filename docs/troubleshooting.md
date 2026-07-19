# Troubleshooting

Progress and errors go to **stderr**. Reports go to a sibling file by default, an
explicit `--output`, or stdout with `--stdout`. The exit code identifies the failure class.

> Confused by the `[allowance]` / `[warning]` lines (e.g. `ceiling ... 2931 cells`)? Those
> are a **worst-case safety ceiling, not work sent** — see
> [`how-it-works.md`](how-it-works.md) for what actually crosses the provider boundary.

## Exit 2 — invalid arguments or unsupported input

- Missing or extra `<video>` positional, or an unknown flag / missing flag value.
- Bad enum value for `--format` (markdown|json) or `--mode` (standard|fast), or a
  non-positive `--max-agent-turns` / `--timeout`.
- Run `videbug --help` for the exact usage.

## Exit 3 — ffmpeg / ffprobe / probing / extraction failure

- **`ffmpeg`/`ffprobe` not found:** install FFmpeg and ensure both are on `PATH`
  (`ffmpeg -version`).
- **Unreadable / corrupt file or unsupported container:** confirm the file plays and
  `ffprobe -show_streams <file>` succeeds.
- **Frame count / PTS mismatch against the catalog:** the source disagrees with its own
  probe metadata; the tool fails closed rather than emit corrupt timing. Re-mux/
  re-encode to a clean CFR/VFR MP4 and retry.

## Exit 4 — Pi auth / model unavailable or model lacks image support

- **No configured auth:** run `pi login` (or configure your provider), then retry.
- **Saved default is text-only or unauthenticated:** the run fails closed instead of
  silently picking another model. Pass a vision-capable model explicitly:
  `--model provider/model`.
- **No vision-capable model available at all:** configure a provider/model that accepts
  images (the agent must see contact sheets and frames).

## Exit 5 — coverage could not be completed (partial result only)

- The default flow **auto-scales** finite inspection ledgers to the video's computed
  obligations, and the submit validator **rejects a premature partial** while any
  deterministic obligation's required resource remains usable (range + cells for gaps;
  full-resolution reads for isolated peaks). A reviewer `accept` runs the same live
  check against its fresh ledger and cannot preserve an avoidable analyst partial. Exit
  5 therefore means an agent successfully submitted an honest structured partial after actual
  inspection exhaustion (most commonly under explicit frozen-evaluation limits).
  Provider, `--timeout`, turn-limit, and cancellation failures normally abort without
  a partial payload instead of manufacturing one.
- A partial report is written to the default sibling file or an explicit `--output`;
  stdout stays empty. If you selected `--stdout`, re-run without it (or use
  `--output report.json`) to retain a future partial, then read
  `coverage.uninspectedRanges` to see what was not inspected.
- For exit 5, inspect `coverage.uninspectedRanges`; a retry may choose better evidence.
  You do **not** need to raise a budget — normal production allowance scales without a
  fixed global cap and is logged as `[allowance] ...`. Timeout/turn/provider failures
  are separate aborted runs: adjust `--timeout`/`--max-agent-turns` or retry those errors.
- Reproducing the frozen evaluation? Setting `VTD_FIXED_BUDGETS=1` pins the historical
  12/250/12 + reviewer-half budgets, under which a long/busy video can legitimately be
  forced to partial when the fixed budget is exhausted.

## Exit 6 — agent failed to submit a valid result

- The analyst could not produce a schema- and citation-valid `submit_analysis` even
  after the single bounded repair turn. This is usually transient model behavior; retry,
  or try a stronger `--model`. Progress on stderr shows the submit attempts/rejections.

## Exit 7 — reviewer rejected the result without a valid replacement

- In `standard` mode the independent reviewer rejected the analyst result and did not
  submit a valid complete replacement. Retry, adjust `--review-model`, or use
  `--mode fast` to skip the reviewer (single-agent pass, less assurance).

## No output / empty stdout

- Empty stdout is normal: the report goes to `<video-stem>.videbug.md` (or `.json`) by
  default, or to the path selected by `--output`.
- Pass `--stdout` when an agent or pipeline needs a complete report on stdout.
- On a partial run (exit 5), stdout is always empty by design; use a file destination.
- Use `--quiet` only to silence progress; it does not change the report destination.

## Fonts / labels look wrong

- The monospace label font is bundled at `assets/fonts/JetBrainsMono-Regular.ttf` and
  registered at runtime. If you installed only `dist/`, ensure `assets/` shipped
  alongside it (it is included in the package `files` allowlist).

## Diagnosing without spending model budget

- `videbug <video> --dry-run` runs only the deterministic engine (probe, scan,
  signals, candidates) and prints a JSON diagnostic. Use it to confirm the source
  probes cleanly and to see candidate counts before a paid run.
- `--keep-artifacts <dir>` preserves the extracted frames and a run manifest (counts,
  budgets, inspected ranges, verdicts — never transcripts) for debugging the tool
  itself.

## Cancellation

- `Ctrl-C` (SIGINT) or `--timeout <seconds>` aborts the run, kills ffmpeg children, and
  removes the private workspace before exiting.
