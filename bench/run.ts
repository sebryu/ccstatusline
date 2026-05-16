#!/usr/bin/env bun
// Benchmark driver for ccstatusline.
//
// Spawns `node dist/ccstatusline.js < payload` N times per payload and reports
// timing percentiles. Optionally runs the same payloads against an alternate
// bin (`--alt`) for before/after comparisons.
//
// Usage:
//   bun bench/run.ts                       # current dist/ccstatusline.js
//   bun bench/run.ts --runs 30             # custom iteration count
//   bun bench/run.ts --alt dist/render.js  # compare two bins on the same payloads
//   bun bench/run.ts --json results.json   # also write machine-readable output

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface Args {
    runs: number;
    bin: string;
    alt?: string;
    jsonOut?: string;
    binArgs: string[];
    env: Record<string, string>;
}

function parseArgs(): Args {
    const args = process.argv.slice(2);
    const out: Args = { runs: 20, bin: 'dist/ccstatusline.js', binArgs: [], env: {} };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const next = () => args[++i];
        if (a === '--runs')
            out.runs = Number(next());
        else if (a === '--bin')
            out.bin = next() ?? out.bin;
        else if (a === '--alt')
            out.alt = next();
        else if (a === '--json')
            out.jsonOut = next();
        else if (a === '--config')
            out.binArgs.push('--config', next() ?? '');
        else if (a === '--env') {
            const kv = next() ?? '';
            const eq = kv.indexOf('=');
            if (eq > 0)
                out.env[kv.slice(0, eq)] = kv.slice(eq + 1);
        } else if (a === '-h' || a === '--help') {
            console.log('Usage: bun bench/run.ts [--runs N] [--bin path] [--alt path] [--json out.json] [--config path] [--env K=V]');
            process.exit(0);
        }
    }
    return out;
}

function runOnce(bin: string, payload: string, extraArgs: string[], env: NodeJS.ProcessEnv): Promise<number> {
    return new Promise((resolve, reject) => {
        const t0 = process.hrtime.bigint();
        const child = spawn('node', [bin, ...extraArgs], { stdio: ['pipe', 'ignore', 'ignore'], env });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) { reject(new Error(`exit ${code}`)); return; }
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            resolve(ms);
        });
        child.stdin.write(payload);
        child.stdin.end();
    });
}

function pct(sorted: number[], p: number): number {
    if (sorted.length === 0)
        return 0;
    const i = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
    return sorted[i]!;
}

interface Stats {
    n: number;
    min: number;
    p50: number;
    p95: number;
    max: number;
    mean: number;
}

function stats(samples: number[]): Stats {
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
        n: sorted.length,
        min: sorted[0] ?? 0,
        p50: pct(sorted, 0.5),
        p95: pct(sorted, 0.95),
        max: sorted[sorted.length - 1] ?? 0,
        mean: sorted.length ? sum / sorted.length : 0
    };
}

function fmt(ms: number) { return `${ms.toFixed(1).padStart(6)} ms`; }

async function bench(bin: string, payloadPath: string, runs: number, extraArgs: string[], env: NodeJS.ProcessEnv) {
    const payload = fs.readFileSync(payloadPath, 'utf-8');
    await runOnce(bin, payload, extraArgs, env).catch(() => {});
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
        samples.push(await runOnce(bin, payload, extraArgs, env));
    }
    return stats(samples);
}

function fileSize(p: string): number {
    try { return fs.statSync(p).size; } catch { return 0; }
}

async function main() {
    const args = parseArgs();
    const repoRoot = path.resolve(__dirname, '..');
    process.chdir(repoRoot);

    if (!fs.existsSync(args.bin)) {
        console.error(`bin not found: ${args.bin} — run \`bun run build\` first`);
        process.exit(1);
    }

    // Make sure synthetic transcripts exist for the relevant payloads
    const synth = [
        { path: '/tmp/cclse-bench-empty.jsonl', entries: 0 },
        { path: '/tmp/cclse-bench-small.jsonl', entries: 50 },
        { path: '/tmp/cclse-bench-large.jsonl', entries: 5000 }
    ];
    for (const s of synth) {
        if (!fs.existsSync(s.path)) {
            await new Promise<void>((resolve, reject) => {
                const c = spawn('bun', ['bench/gen-transcript.ts', s.path, String(s.entries)], { stdio: 'inherit' });
                c.on('close', (code) => { code === 0 ? resolve() : reject(new Error(`gen-transcript exit ${code}`)); });
            });
        }
    }

    const payloads = fs.readdirSync('bench/payloads').filter(f => f.endsWith('.json')).map(f => `bench/payloads/${f}`);

    const bins: { label: string; path: string }[] = [{ label: 'current', path: args.bin }];
    if (args.alt)
        bins.push({ label: 'alt', path: args.alt });

    console.log(`runs: ${args.runs}`);
    for (const b of bins) {
        console.log(`${b.label}: ${b.path}  (${(fileSize(b.path) / 1024).toFixed(1)} KiB)`);
    }
    console.log('');

    const rows: { bin: string; payload: string; stats: Stats }[] = [];

    const env = { ...process.env, ...args.env };
    for (const p of payloads) {
        for (const b of bins) {
            const s = await bench(b.path, p, args.runs, args.binArgs, env);
            rows.push({ bin: b.label, payload: path.basename(p), stats: s });
        }
    }

    console.log('| payload | bin | min | p50 | p95 | max | mean |');
    console.log('|---|---|---|---|---|---|---|');
    for (const r of rows) {
        const s = r.stats;
        console.log(`| ${r.payload} | ${r.bin} | ${fmt(s.min)} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.max)} | ${fmt(s.mean)} |`);
    }

    if (args.jsonOut) {
        fs.writeFileSync(args.jsonOut, JSON.stringify({ args, rows }, null, 2));
        console.log(`\nwrote ${args.jsonOut}`);
    }
}

void main();
