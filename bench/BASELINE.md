# Baseline — upstream ccstatusline 2.2.18

Captured on `perf/wave-1` branch, before any code changes. Hardware: darwin/arm64.

```
bun bench/run.ts --runs 15 --json bench/baseline.json
```

| payload | bin | min | p50 | p95 | max | mean |
|---|---|---|---|---|---|---|
| minimal.json | current |  187.1 ms |  201.3 ms |  232.0 ms |  262.0 ms |  208.2 ms |
| default.json | current |  188.7 ms |  193.2 ms |  202.0 ms |  204.0 ms |  194.8 ms |
| large-transcript.json | current |  199.1 ms |  204.6 ms |  211.0 ms |  213.3 ms |  205.1 ms |

Bundle: `dist/ccstatusline.js` = **3.08 MiB**, 77 197 lines, 408 modules.

## Observations

- A render takes ~200 ms whether the payload is empty or carries a 916 KiB synthetic transcript — i.e. **bundle load dominates**, transcript parsing is in the noise (~10 ms) at this size.
- That matches the suspicion that the render path needlessly pulls in React 19 + Ink + ink-gradient + ink-select-input + react-devtools-core + zod, which only the TUI uses.
- The transcript-parsing cost surfaces in a different regime: many parallel CC sessions, very large transcripts, or widgets that re-parse on every refresh (issue #137). Not visible in the single-process refresh benchmark, but still worth fixing.
