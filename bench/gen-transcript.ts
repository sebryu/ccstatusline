#!/usr/bin/env bun
// Generate a synthetic Claude Code transcript JSONL at the given path.
// Usage: bun bench/gen-transcript.ts <path> <entries>
import * as fs from 'fs';

const path = process.argv[2];
const entries = Number(process.argv[3] ?? 5000);
if (!path) {
    console.error('usage: gen-transcript.ts <path> <entries>');
    process.exit(1);
}

const lines: string[] = [];
const start = Date.now() - entries * 1000;

for (let i = 0; i < entries; i++) {
    const ts = new Date(start + i * 1000).toISOString();
    const isAssistant = i % 2 === 1;
    const line = {
        type: isAssistant ? 'assistant' : 'user',
        timestamp: ts,
        isSidechain: false,
        message: isAssistant
            ? {
                role: 'assistant',
                stop_reason: i === entries - 1 ? null : 'end_turn',
                usage: {
                    input_tokens: 200 + (i % 50),
                    output_tokens: 150 + (i % 80),
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 1200 + i * 3
                }
            }
            : { role: 'user', content: 'placeholder' }
    };
    lines.push(JSON.stringify(line));
}

fs.writeFileSync(path, lines.join('\n') + '\n');
const stat = fs.statSync(path);
console.log(`wrote ${entries} entries (${(stat.size / 1024).toFixed(1)} KiB) -> ${path}`);
