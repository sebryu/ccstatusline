#!/usr/bin/env bun
// Microbenchmark: per-render cost of the 3 transcript-reading entry points.
// Confirms whether the readJsonlLines cache is delivering real savings.

import { __resetJsonlLinesCacheForTests } from '../src/utils/jsonl-lines';
import {
    getSessionDuration,
    getSpeedMetricsCollection,
    getTokenMetrics
} from '../src/utils/jsonl-metrics';

const transcriptPath = process.argv[2] ?? '/tmp/cclse-bench-large.jsonl';
const runs = Number(process.argv[3] ?? 30);

async function oneRender(useCache: boolean) {
    if (!useCache) {
        process.env.CCSL_NO_LINES_CACHE = '1';
    }
    __resetJsonlLinesCacheForTests();
    const t0 = process.hrtime.bigint();
    await getTokenMetrics(transcriptPath);
    await getSessionDuration(transcriptPath);
    await getSpeedMetricsCollection(transcriptPath, { includeSubagents: true, windowSeconds: [60, 300] });
    return Number(process.hrtime.bigint() - t0) / 1e6;
}

function stats(samples: number[]) {
    const sorted = [...samples].sort((a, b) => a - b);
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))]!;
    return {
        min: sorted[0]!,
        p50: p(0.5),
        p95: p(0.95),
        max: sorted[sorted.length - 1]!,
        mean: sorted.reduce((a, b) => a + b, 0) / sorted.length
    };
}

async function main() {
    for (const useCache of [false, true]) {
        const samples: number[] = [];
        for (let i = 0; i < runs; i++)
            samples.push(await oneRender(useCache));
        const s = stats(samples);
        console.log(`cache=${String(useCache).padStart(5)}: min=${s.min.toFixed(2)}ms p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms mean=${s.mean.toFixed(2)}ms`);
    }
}

void main();
