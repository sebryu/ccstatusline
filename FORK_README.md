# ccstatusline-fast (private fork)

Private fork of [ccstatusline](https://github.com/sirmalloc/ccstatusline) focused on **cold-start latency**. Every Claude Code status-line refresh re-spawns the binary, so reducing per-invocation wall-clock time directly reduces UI lag.

Branch: `perf/wave-1`, rebased onto upstream `2.2.27` (3 perf commits + this doc). Commit SHAs are deliberately not cited below — the branch is rebased onto upstream on every update, which rewrites them.

The bundle Claude Code actually runs is built from a separate clone at `~/.local/share/ccstatusline-live`, so development in this tree never disturbs the live status line. Refresh it by running `ccstatusline-update` (`~/.local/bin/ccstatusline-update`): it fast-forwards this repo's `main`, rebases `perf/wave-1` if needed, then resets and rebuilds the live clone. The script deliberately lives outside the clone, since it `git reset --hard`s that directory and bash reads scripts incrementally.

## Headline numbers

Re-measured 2026-08-14 against upstream **2.2.27** on darwin/arm64, both bins built from source and driven by the same runtime, with a real 13-widget config. Samples are interleaved round-robin between bins so machine drift hits each equally — measuring bins in consecutive blocks produced p50/mean disagreements of 20 ms+ on this hardware. 30 runs (12 for the 36 MiB case).

Typical session (454 KiB transcript):

| runtime | upstream 2.2.27 p50 | fork p50 | Δ |
|---|---|---|---|
| `bun` | 158.3 ms | 143.6 ms | **−9.3%** |
| `node` | 186.9 ms | 167.0 ms | **−10.6%** |

Heavy session (36 MiB transcript, `bun`): 225.6 ms → **197.6 ms** (**−12.4%**).

Entry bundle: **3.22 MiB → 19.8 KiB** (−99%). Render-path closure is still ~2.0 MiB due to widget→shared-editor→React/Ink coupling — wave 2 target.

The runtime matters as much as the fork: on the same fork bundle, `bun` beats `node` by ~14% (167.0 → 143.6 ms), because at this scale most of the wall clock is process startup, not our code. Best combination is `bun` + fork bundle at 143.6 ms vs 186.9 ms for the stock `node` + upstream pairing — **−23%** end to end.

## What changed

### 1. Lazy-load the TUI

Upstream emits a single 3.15 MiB `dist/ccstatusline.js` that statically imports the entire TUI (React 19 + Ink + ink-gradient + ink-select-input + react-devtools-core + zod) even though piped status-line renders never touch any of it.

- `src/ccstatusline.ts`: top-level `import { runTUI } from './tui'` → `await import('./tui')` inside the TTY branch.
- `package.json` build: added `--splitting --outdir=dist` so Bun emits the TUI chain as a separate chunk.

Result: dispatcher entry shrinks from 3.15 MiB to 23 KiB. The render path no longer parses the TUI dependency graph at all.

### 2. In-process JSONL read cache

The default render path calls `readJsonlLines` up to 3× per invocation (`getTokenMetrics`, `getSessionDuration`, `getSpeedMetricsCollection`), each re-reading and re-splitting the whole transcript.

- `src/utils/jsonl-lines.ts`: cache the split-by-newline result keyed by absolute path, validated against `fs.stat()` `mtime` + `size`. 2nd/3rd calls within the same process are O(1).
- Opt-out via `CCSL_NO_LINES_CACHE=1`.

Small in absolute terms (<2 ms p50 even at a 9 MiB transcript — the dominant cost is `JSON.parse` per line, not read+split), but it compounds with #1 on heavy configs and lays the foundation for a future parsed-entries cache and for the parallel-CC scenario in upstream issue #137.

### 3. Benchmark harness

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
