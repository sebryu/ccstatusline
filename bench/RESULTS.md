# Wave 1 results — perf/wave-1 vs upstream ccstatusline 2.2.18

Hardware: darwin/arm64. `node` was used for both bins to keep the runtime variable controlled.

```
bun bench/run.ts --runs 20 \
    --bin /tmp/ccsl-inspect/package/dist/ccstatusline.js \
    --alt dist/ccstatusline.js
```

## Head-to-head (default config — no `--config`)

| payload | upstream p50 | fork p50 | Δ |
|---|---|---|---|
| minimal.json | 202.5 ms | 179.5 ms | **−11%** |
| default.json | 193.6 ms | 187.5 ms | −3% |
| large-transcript.json | 200.9 ms | 193.2 ms | −4% |

## Head-to-head (heavy config — transcript-reading widgets enabled)

`--config bench/heavy.settings.json` enables `context-length`, `tokens-{input,output,cached,total}`, `session-clock`, `session-cost`, `{input,output,total}-speed`.

In the bench harness output, `current` = upstream (the `--bin`), `alt` = fork (the `--alt`).

| payload | upstream p50 | fork p50 | Δ |
|---|---|---|---|
| minimal.json | 152.6 ms | 147.6 ms | −3% |
| default.json | 152.0 ms | 142.3 ms | **−6%** |
| large-transcript.json | 173.5 ms | 156.1 ms | **−10%** |

The fork is consistently faster, with the largest win on the large-transcript case where read-cache dedup compounds with the smaller-entry win.

## Bundle size

| build | entry | render closure | total |
|---|---|---|---|
| upstream 2.2.18 | 3.15 MiB (single `dist/ccstatusline.js`) | 3.15 MiB | 3.15 MiB |
| fork (this branch) | **23 KiB** | 23 KiB + 1.86 MiB chunk | 3.00 MiB |

The entry shrunk by 99% but the render path still requires loading the 1.86 MiB chunk because of structural coupling (see "Why the entry-shrink didn't translate to render speed", below).

## Microbench — `getTokenMetrics + getSessionDuration + getSpeedMetricsCollection`

```
bun bench/micro-jsonl.ts /tmp/cclse-bench-large.jsonl 50   # 916 KiB transcript
cache=false: min=5.77ms p50=6.18ms p95=6.84ms mean=6.40ms
cache=true : min=5.82ms p50=6.36ms p95=6.96ms mean=6.40ms

bun bench/micro-jsonl.ts /tmp/cclse-bench-huge.jsonl 30    # 9.0 MiB transcript
cache=false: min=60.40ms p50=63.25ms p95=70.14ms mean=64.06ms
cache=true : min=61.04ms p50=61.96ms p95=63.71ms mean=62.25ms
```

→ The in-process read cache saves <1 ms at 916 KiB, ~2 ms at 9 MiB. It's a small win that would only matter for extremely large transcripts. The cache is kept (low-cost, slightly-positive at scale, and a foundation for a future parsed-entries cache) but not material for typical usage. Opt out via `CCSL_NO_LINES_CACHE=1`.

## Why the entry-shrink didn't translate to render speed

The dispatcher pattern works — `dist/ccstatusline.js` is 23 KiB and dynamically imports the TUI. But the **render-path chunk is still 1.86 MiB** because:

- `src/utils/widget-manifest.ts` does `import * as widgets from '../widgets'` to register all 78 widgets.
- Every widget file (including `.ts` ones like `BlockResetTimer.ts`, `InputSpeed.ts`, `OutputSpeed.ts`, `TotalSpeed.ts`, `WeeklyResetTimer.ts`) statically imports from `./shared/locale-editor.tsx`, `./shared/timezone-editor.tsx`, or `./shared/speed-widget.tsx`.
- Those shared `.tsx` files import `ink` and `react`, which transitively pulls in `react-reconciler`, `signal-exit`, `cli-boxes`, `picomatch`, `tinyglobby`, `debug`, etc. — the bulk of the 1.86 MiB.

An experiment that removed only the six `.tsx` widget files from the manifest dropped the chunk by 40 KiB — confirming React/Ink leakage is dominated by the shared editor modules used by `.ts` widgets, not by `.tsx` widget files themselves.

**Wave 2 plan:** restructure each widget so render and editor are separate exports loaded from separate modules. The manifest holds renderers; editors are dynamically imported by the TUI only. Estimated impact: render chunk → <200 KiB, p50 cold-start → <80 ms (Node-startup floor territory). Scope: ~12 widget files + 3 shared-editor files.

## Reproducing

```
git checkout perf/wave-1
bun install
bun run build

# Baseline (current build)
bun bench/run.ts --runs 20

# Head-to-head vs upstream 2.2.18 (assumes upstream tarball unpacked in /tmp)
mkdir -p /tmp/ccsl-inspect && cd /tmp/ccsl-inspect && npm pack ccstatusline@2.2.18 && tar xzf ccstatusline-2.2.18.tgz && cd -
bun bench/run.ts --runs 20 \
  --bin /tmp/ccsl-inspect/package/dist/ccstatusline.js \
  --alt dist/ccstatusline.js
```
