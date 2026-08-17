import * as fs from 'fs';
import { promisify } from 'util';

const readFile = promisify(fs.readFile);
const readFileSync = fs.readFileSync;
const stat = promisify(fs.stat);

function splitJsonlContent(content: string): string[] {
    return content.trim().split('\n').filter(line => line.length > 0);
}

// In-process cache of split JSONL lines, keyed by absolute path.
// The default ccstatusline render path calls readJsonlLines up to 3× per
// invocation (getTokenMetrics, getSessionDuration, getSpeedMetricsCollection),
// each independently re-reading and splitting the same file. The cache
// validates against mtime+size so a transcript update mid-render still wins.
//
// Behavior is opt-out via CCSL_NO_LINES_CACHE for diagnostics.
interface CacheEntry {
    mtimeMs: number;
    size: number;
    lines: string[];
}

const linesCache = new Map<string, CacheEntry>();
const cacheDisabled = process.env.CCSL_NO_LINES_CACHE === '1';

function takeFromCache(filePath: string, mtimeMs: number, size: number): string[] | null {
    if (cacheDisabled)
        return null;
    const entry = linesCache.get(filePath);
    if (entry?.mtimeMs === mtimeMs && entry.size === size) {
        return entry.lines;
    }
    return null;
}

function storeInCache(filePath: string, mtimeMs: number, size: number, lines: string[]): void {
    if (cacheDisabled)
        return;
    linesCache.set(filePath, { mtimeMs, size, lines });
}

export async function readJsonlLines(filePath: string): Promise<string[]> {
    try {
        const s = await stat(filePath);
        const hit = takeFromCache(filePath, s.mtimeMs, s.size);
        if (hit)
            return hit;

        const content = await readFile(filePath, 'utf-8');
        const lines = splitJsonlContent(content);
        storeInCache(filePath, s.mtimeMs, s.size, lines);
        return lines;
    } catch {
        // Preserve original semantics: any I/O failure falls through to a
        // plain readFile so the caller's try/catch shape is unchanged.
        const content = await readFile(filePath, 'utf-8');
        return splitJsonlContent(content);
    }
}

export function readJsonlLinesSync(filePath: string): string[] {
    try {
        const s = fs.statSync(filePath);
        const hit = takeFromCache(filePath, s.mtimeMs, s.size);
        if (hit)
            return hit;

        const content = readFileSync(filePath, 'utf-8');
        const lines = splitJsonlContent(content);
        storeInCache(filePath, s.mtimeMs, s.size, lines);
        return lines;
    } catch {
        const content = readFileSync(filePath, 'utf-8');
        return splitJsonlContent(content);
    }
}

export function parseJsonlLine(line: string): unknown {
    try {
        return JSON.parse(line) as unknown;
    } catch {
        return null;
    }
}

// Exposed for tests/benchmarks only.
export function __resetJsonlLinesCacheForTests(): void {
    linesCache.clear();
}
