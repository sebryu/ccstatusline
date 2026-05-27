# ccstatusline-fast (private fork)

Private fork of [ccstatusline](https://github.com/sirmalloc/ccstatusline) focused on **cold-start latency**. Every Claude Code status-line refresh re-spawns the binary, so reducing per-invocation wall-clock time directly reduces UI lag.

Branch: `perf/wave-1`, rebased onto upstream `2.2.27` (3 perf commits + this doc).

## Headline numbers

Measured on darwin/arm64 with `node` driving both binaries (same runtime for fork and upstream) — see `bench/RESULTS.md` for the full table and reproduction recipe.

| payload | upstream 2.2.18 p50 | fork p50 | Δ |
|---|---|---|---|
| minimal.json | 202.5 ms | 179.5 ms | **−11%** |
| default.json (default config) | 193.6 ms | 187.5 ms | −3% |
| large-transcript.json | 200.9 ms | 193.2 ms | −4% |
| large-transcript.json (heavy config) | 173.5 ms | 156.1 ms | **−10%** |

Entry bundle: **3.15 MiB → 23 KiB** (−99%). Render-path closure is still ~1.86 MiB due to widget→shared-editor→React/Ink coupling — wave 2 target.

## What changed

### 1. Lazy-load the TUI (`7132c26`)

Upstream emits a single 3.15 MiB `dist/ccstatusline.js` that statically imports the entire TUI (React 19 + Ink + ink-gradient + ink-select-input + react-devtools-core + zod) even though piped status-line renders never touch any of it.

- `src/ccstatusline.ts`: top-level `import { runTUI } from './tui'` → `await import('./tui')` inside the TTY branch.
- `package.json` build: added `--splitting --outdir=dist` so Bun emits the TUI chain as a separate chunk.

Result: dispatcher entry shrinks from 3.15 MiB to 23 KiB. The render path no longer parses the TUI dependency graph at all.

### 2. In-process JSONL read cache (`dee8f1c`)

The default render path calls `readJsonlLines` up to 3× per invocation (`getTokenMetrics`, `getSessionDuration`, `getSpeedMetricsCollection`), each re-reading and re-splitting the whole transcript.

- `src/utils/jsonl-lines.ts`: cache the split-by-newline result keyed by absolute path, validated against `fs.stat()` `mtime` + `size`. 2nd/3rd calls within the same process are O(1).
- Opt-out via `CCSL_NO_LINES_CACHE=1`.

Small in absolute terms (<2 ms p50 even at a 9 MiB transcript — the dominant cost is `JSON.parse` per line, not read+split), but it compounds with #1 on heavy configs and lays the foundation for a future parsed-entries cache and for the parallel-CC scenario in upstream issue #137.

### 3. Benchmark harness (`24e7113`)

Reproducible cold-start measurements so future perf changes are evidence-driven, not vibes.

- `bench/run.ts` — spawns `node dist/ccstatusline.js < payload` N times, reports min/p50/p95/max/mean, supports `--alt` for head-to-head comparison against another binary.
- `bench/micro-jsonl.ts` — isolates transcript-parsing cost from bundle-load cost.
- `bench/gen-transcript.ts` — synthesizes large JSONL transcripts for stress testing.
- `bench/payloads/` — fixed `minimal.json`, `default.json`, `large-transcript.json` payloads.
- `bench/heavy.settings.json` — config that enables transcript-reading widgets (`context-length`, `tokens-*`, `session-clock`, `session-cost`, `*-speed`).
- `bench/BASELINE.md`, `bench/RESULTS.md` — captured numbers + analysis.
- `eslint.config.js` excludes `bench/` (dev scripts, not shipped).

## Why the entry-shrink didn't translate 1:1 into render-path speed

The dispatcher works: the 23 KiB entry only loads what the render path needs. But the **render-path chunk is still 1.86 MiB** because:

- `src/utils/widget-manifest.ts` does `import * as widgets from '../widgets'` to register all 78 widgets.
- Every widget file (including pure-`.ts` ones like `BlockResetTimer.ts`, `InputSpeed.ts`, `OutputSpeed.ts`, `TotalSpeed.ts`, `WeeklyResetTimer.ts`) statically imports from `./shared/locale-editor.tsx`, `./shared/timezone-editor.tsx`, or `./shared/speed-widget.tsx`.
- Those shared `.tsx` editor modules import `ink` + `react`, which transitively pulls in `react-reconciler`, `signal-exit`, `cli-boxes`, `picomatch`, `tinyglobby`, `debug`, etc. — the bulk of the 1.86 MiB.

An experiment that removed only the six `.tsx` widget files from the manifest dropped the chunk by 40 KiB — confirming React/Ink leakage is dominated by shared editor modules used by `.ts` widgets, not by `.tsx` widget files themselves.

### Wave 2 plan (not yet started)

Restructure each widget so render and editor are separate exports loaded from separate modules. The manifest holds renderers; editors are dynamically imported by the TUI only.

- Estimated impact: render-path chunk → <200 KiB, p50 cold-start → <80 ms (Node-startup-floor territory).
- Scope: ~12 widget files + 3 shared-editor files.

## Reproducing the numbers

```bash
git checkout perf/wave-1
bun install
bun run build

# Fork baseline
bun bench/run.ts --runs 20

# Head-to-head vs upstream 2.2.18
mkdir -p /tmp/ccsl-inspect && cd /tmp/ccsl-inspect \
  && npm pack ccstatusline@2.2.18 && tar xzf ccstatusline-2.2.18.tgz && cd -
bun bench/run.ts --runs 20 \
  --bin /tmp/ccsl-inspect/package/dist/ccstatusline.js \
  --alt dist/ccstatusline.js
```

## Compatibility

No behavior changes for existing widgets or configs. Same CLI surface, same settings file (`~/.config/ccstatusline/settings.json`), same widget set as upstream; existing configs render identically. The TUI still launches on TTY-without-piped-stdin; the only user-visible difference from the perf work is that the first TUI launch within a process pays a one-time `import('./tui')` cost (negligible — the chunk is on disk next to the entry).

## Relationship to upstream

Tracking upstream `main`. The fork's original Cache Hit Rate widget was upstreamed as #409 and dropped from this branch during the rebase onto `2.2.27` — upstream's version supersedes it. The perf commits remain clean cherry-pick candidates if upstream wants them, but are not yet submitted as PRs — the fork exists primarily for personal use on a high-frequency status-line refresh setup.
