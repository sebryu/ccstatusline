import * as fs from 'fs';
import path from 'node:path';

import type {
    SpeedMetrics,
    TokenMetrics,
    TranscriptLine
} from '../types';
import type {
    ModelTokenBucketMap,
    ModelTokenBuckets,
    TokenBucket
} from '../types/TokenMetrics';

import {
    getCompactBoundaryPostTokens,
    isCompactBoundary
} from './compaction';
import {
    parseJsonlLine,
    readJsonlLines
} from './jsonl-lines';
import { LONG_CONTEXT_THRESHOLD_TOKENS } from './pricing';

export interface SpeedMetricsOptions {
    includeSubagents?: boolean;
    windowSeconds?: number;
}

interface SpeedMetricsCollectionOptions {
    includeSubagents?: boolean;
    windowSeconds?: number[];
}

export interface SpeedMetricsCollection {
    sessionAverage: SpeedMetrics;
    windowed: Record<string, SpeedMetrics>;
}

interface SpeedInterval {
    startMs: number;
    endMs: number;
}

interface SpeedRequest {
    inputTokens: number;
    outputTokens: number;
    assistantTimestampMs: number | null;
    interval: SpeedInterval | null;
}

interface CollectedSpeedMetrics {
    requests: SpeedRequest[];
    latestTimestampMs: number | null;
}

function collectAgentIds(value: unknown, agentIds: Set<string>) {
    if (!value || typeof value !== 'object') {
        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectAgentIds(item, agentIds);
        }
        return;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
        if (key === 'agentId' && typeof nestedValue === 'string' && nestedValue.trim() !== '') {
            agentIds.add(nestedValue);
            continue;
        }

        collectAgentIds(nestedValue, agentIds);
    }
}

function getReferencedSubagentIds(lines: string[]): Set<string> {
    const agentIds = new Set<string>();

    for (const line of lines) {
        const data = parseJsonlLine(line);
        if (!data) {
            continue;
        }

        collectAgentIds(data, agentIds);
    }

    return agentIds;
}

function createTokenBucket(): TokenBucket {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0
    };
}

function createModelTokenBuckets(): ModelTokenBuckets {
    return { standard: createTokenBucket(), longContext: createTokenBucket() };
}

/**
 * Adds one usage entry to its model's bucket.
 *
 * The entry lands in the long-context bucket when its prompt (input plus both
 * kinds of cached tokens) crosses the threshold where long-context models bill
 * at a premium, so the two tiers can be priced separately later.
 */
function accumulateModelUsage(byModel: ModelTokenBucketMap, entry: TranscriptLine): void {
    const usage = entry.message?.usage;
    const model = entry.message?.model;
    if (!usage || !model) {
        return;
    }

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const totalCacheCreation = usage.cache_creation_input_tokens ?? 0;

    // Older transcripts carry only the aggregate cache_creation_input_tokens.
    // Without the TTL split, attribute it to the cheaper 5m tier so the
    // estimate errs low rather than inventing a premium that may not apply.
    const cacheCreation1hTokens = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const cacheCreation5mTokens = usage.cache_creation?.ephemeral_5m_input_tokens
        ?? Math.max(totalCacheCreation - cacheCreation1hTokens, 0);

    const buckets = byModel[model] ?? createModelTokenBuckets();
    byModel[model] = buckets;

    const promptTokens = inputTokens + cacheReadTokens + totalCacheCreation;
    const bucket = promptTokens > LONG_CONTEXT_THRESHOLD_TOKENS ? buckets.longContext : buckets.standard;

    bucket.inputTokens += inputTokens;
    bucket.outputTokens += outputTokens;
    bucket.cacheReadTokens += cacheReadTokens;
    bucket.cacheCreation5mTokens += cacheCreation5mTokens;
    bucket.cacheCreation1hTokens += cacheCreation1hTokens;
}

/**
 * Builds per-model token buckets from usage entries, counting each API request once.
 *
 * A single request emits one transcript line per content block - four parallel
 * tool calls produce four lines - and every one of them repeats the request's
 * full usage totals. Summing the lines therefore multiplies the bill, so entries
 * are keyed per request and the last line for each one wins (during streaming
 * that is the finalized one).
 *
 * Transcripts written through Bedrock carry no requestId at all, so the
 * assistant message id is the fallback key: it is equally unique per API
 * response, and without it every repeated line is counted again and the
 * estimate comes out several times too high.
 */
export function buildModelTokenBuckets(entries: TranscriptLine[]): ModelTokenBucketMap {
    const byModel: ModelTokenBucketMap = {};
    const lastEntryPerRequest = new Map<string, TranscriptLine>();

    for (const entry of entries) {
        if (!entry.message?.usage) {
            continue;
        }

        const requestKey = entry.requestId ?? entry.message.id;
        if (requestKey) {
            lastEntryPerRequest.set(requestKey, entry);
            continue;
        }

        accumulateModelUsage(byModel, entry);
    }

    for (const entry of lastEntryPerRequest.values()) {
        accumulateModelUsage(byModel, entry);
    }

    return byModel;
}

export function mergeModelTokenBuckets(target: ModelTokenBucketMap, source: ModelTokenBucketMap): ModelTokenBucketMap {
    for (const [model, buckets] of Object.entries(source)) {
        const existing = target[model] ?? createModelTokenBuckets();
        target[model] = existing;

        for (const tier of ['standard', 'longContext'] as const) {
            existing[tier].inputTokens += buckets[tier].inputTokens;
            existing[tier].outputTokens += buckets[tier].outputTokens;
            existing[tier].cacheReadTokens += buckets[tier].cacheReadTokens;
            existing[tier].cacheCreation5mTokens += buckets[tier].cacheCreation5mTokens;
            existing[tier].cacheCreation1hTokens += buckets[tier].cacheCreation1hTokens;
        }
    }

    return target;
}

/**
 * Claude Code writes several JSONL entries per API call while streaming:
 * intermediate ones carry stop_reason: null and the final one carries a string.
 * Counting every entry would multiply the tokens of each turn, so keep the
 * finalized entries plus the single in-flight one. Transcripts with no
 * stop_reason field at all are counted whole.
 */
export function selectCountedEntries<T extends { data: TranscriptLine }>(
    parsedEntries: T[],
    hasStopReasonField: boolean
): T[] {
    if (!hasStopReasonField) {
        return parsedEntries;
    }

    return parsedEntries.filter((entry, index) => {
        const stopReason = entry.data.message?.stop_reason;
        return Boolean(stopReason) || (stopReason === null && index === parsedEntries.length - 1);
    });
}

/**
 * Per-model tokens spent by subagents whose turns live in their own transcript
 * files rather than in the parent session's. Those turns are billed like any
 * other, so omitting them under-reports a session that delegated work.
 */
export async function getSubagentModelBuckets(transcriptPath: string): Promise<ModelTokenBucketMap> {
    const byModel: ModelTokenBucketMap = {};

    try {
        if (!fs.existsSync(transcriptPath)) {
            return byModel;
        }

        const mainLines = await readJsonlLines(transcriptPath);
        const referencedAgentIds = getReferencedSubagentIds(mainLines);
        const subagentPaths = getSubagentTranscriptPaths(transcriptPath, referencedAgentIds);

        const bucketsPerAgent = await Promise.all(subagentPaths.map(async (subagentPath) => {
            try {
                const lines = await readJsonlLines(subagentPath);
                const entries: TranscriptLine[] = [];
                for (const line of lines) {
                    const data = parseJsonlLine(line) as TranscriptLine | null;
                    if (data?.message?.usage) {
                        entries.push(data);
                    }
                }

                return buildModelTokenBuckets(entries);
            } catch {
                return null;
            }
        }));

        for (const agentBuckets of bucketsPerAgent) {
            if (agentBuckets) {
                mergeModelTokenBuckets(byModel, agentBuckets);
            }
        }
    } catch {
        return byModel;
    }

    return byModel;
}

export async function getSessionDuration(transcriptPath: string): Promise<string | null> {
    try {
        if (!fs.existsSync(transcriptPath)) {
            return null;
        }

        const lines = await readJsonlLines(transcriptPath);

        if (lines.length === 0) {
            return null;
        }

        let firstTimestamp: Date | null = null;
        let lastTimestamp: Date | null = null;

        // Find first valid timestamp
        for (const line of lines) {
            const data = parseJsonlLine(line) as { timestamp?: string } | null;
            if (data?.timestamp) {
                firstTimestamp = new Date(data.timestamp);
                break;
            }
        }

        // Find last valid timestamp (iterate backwards)
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (!line) {
                continue;
            }

            const data = parseJsonlLine(line) as { timestamp?: string } | null;
            if (data?.timestamp) {
                lastTimestamp = new Date(data.timestamp);
                break;
            }
        }

        if (!firstTimestamp || !lastTimestamp) {
            return null;
        }

        // Calculate duration in milliseconds
        const durationMs = lastTimestamp.getTime() - firstTimestamp.getTime();

        // Convert to minutes
        const totalMinutes = Math.floor(durationMs / (1000 * 60));

        if (totalMinutes < 1) {
            return '<1m';
        }

        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        if (hours === 0) {
            return `${minutes}m`;
        } else if (minutes === 0) {
            return `${hours}hr`;
        } else {
            return `${hours}hr ${minutes}m`;
        }
    } catch {
        return null;
    }
}

export async function getTokenMetrics(transcriptPath: string): Promise<TokenMetrics> {
    try {
        // Use Node.js-compatible file reading
        if (!fs.existsSync(transcriptPath)) {
            return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, contextLength: 0, byModel: {} };
        }

        const lines = await readJsonlLines(transcriptPath);

        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;
        let contextLength = 0;

        // Parse each line and sum up token usage for totals.
        // Claude Code writes multiple JSONL entries per API call during streaming:
        // intermediate entries have stop_reason: null, and the final entry has a
        // string value like "end_turn" or "tool_use". For streaming-aware
        // transcripts, count finalized entries plus the latest unfinished entry so
        // live updates do not overcount duplicate partial rows. If the transcript
        // format has no stop_reason field at all, fall back to counting all entries.
        //
        // Claude Code also writes a { type:'system', subtype:'compact_boundary' }
        // record on every compaction. Usage entries before the most recent boundary
        // describe a context that no longer exists, so they must not drive context
        // length - otherwise it stays stuck at the pre-compaction size until the
        // next turn repopulates Claude Code's live status data.
        let mostRecentMainChainEntry: TranscriptLine | null = null;
        let mostRecentTimestamp: Date | null = null;
        let mostRecentPostCompactionEntry: TranscriptLine | null = null;
        let mostRecentPostCompactionTimestamp: Date | null = null;
        let lastCompactBoundaryLineIndex = -1;
        let lastCompactBoundaryPostTokens: number | null = null;

        const parsedEntries: { data: TranscriptLine; lineIndex: number }[] = [];
        let hasStopReasonField = false;

        for (const [lineIndex, line] of lines.entries()) {
            const data = parseJsonlLine(line) as TranscriptLine | null;
            if (isCompactBoundary(data)) {
                lastCompactBoundaryLineIndex = lineIndex;
                lastCompactBoundaryPostTokens = getCompactBoundaryPostTokens(data);
            }
            if (data?.message?.usage) {
                parsedEntries.push({ data, lineIndex });
                if (Object.hasOwn(data.message, 'stop_reason')) {
                    hasStopReasonField = true;
                }
            }
        }

        const entriesToCount = selectCountedEntries(parsedEntries, hasStopReasonField);

        for (const { data, lineIndex } of entriesToCount) {
            const usage = data.message?.usage;
            if (!usage) {
                continue;
            }

            inputTokens += usage.input_tokens || 0;
            outputTokens += usage.output_tokens || 0;
            cacheReadTokens += usage.cache_read_input_tokens ?? 0;
            cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;

            // Track the most recent entry with isSidechain: false (or undefined, which defaults to main chain)
            // Also skip API error messages (synthetic messages with 0 tokens)
            if (data.isSidechain !== true && data.timestamp && !data.isApiErrorMessage) {
                const entryTime = new Date(data.timestamp);
                if (!mostRecentTimestamp || entryTime > mostRecentTimestamp) {
                    mostRecentTimestamp = entryTime;
                    mostRecentMainChainEntry = data;
                }
                if (lineIndex > lastCompactBoundaryLineIndex
                    && (!mostRecentPostCompactionTimestamp || entryTime > mostRecentPostCompactionTimestamp)) {
                    mostRecentPostCompactionTimestamp = entryTime;
                    mostRecentPostCompactionEntry = data;
                }
            }
        }

        // Context length is the live occupancy of the current context window.
        // Without a compaction it is the most recent main-chain turn. After a
        // compaction, prefer the first turn following the boundary, then the
        // boundary's reported post-compaction size, and otherwise 0 - the stale
        // pre-compaction turn must never leak through.
        const contextLengthFromEntry = (entry: TranscriptLine | null): number | null => {
            const usage = entry?.message?.usage;
            if (!usage) {
                return null;
            }
            return (usage.input_tokens || 0)
                + (usage.cache_read_input_tokens ?? 0)
                + (usage.cache_creation_input_tokens ?? 0);
        };

        contextLength = lastCompactBoundaryLineIndex >= 0
            ? (contextLengthFromEntry(mostRecentPostCompactionEntry) ?? lastCompactBoundaryPostTokens ?? 0)
            : (contextLengthFromEntry(mostRecentMainChainEntry) ?? 0);

        // Cost is derived from every usage entry with per-request deduping, which is
        // stricter than the stop_reason rule the legacy totals above still use.
        const byModel = buildModelTokenBuckets(parsedEntries.map(entry => entry.data));

        const cachedTokens = cacheReadTokens + cacheCreationTokens;
        const totalTokens = inputTokens + outputTokens + cachedTokens;

        return { inputTokens, outputTokens, cachedTokens, cacheReadTokens, cacheCreationTokens, totalTokens, contextLength, byModel };
    } catch {
        return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, contextLength: 0, byModel: {} };
    }
}

function parseTimestamp(value: string | undefined): Date | null {
    if (!value) {
        return null;
    }

    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function mergeIntervals(intervals: SpeedInterval[]): SpeedInterval[] {
    if (intervals.length === 0) {
        return [];
    }

    const sorted = intervals
        .slice()
        .sort((a, b) => a.startMs - b.startMs);
    const first = sorted[0];
    if (!first) {
        return [];
    }
    const merged: SpeedInterval[] = [{ ...first }];

    for (let i = 1; i < sorted.length; i++) {
        const current = sorted[i];
        const last = merged[merged.length - 1];
        if (!current || !last) {
            continue;
        }

        if (current.startMs <= last.endMs) {
            last.endMs = Math.max(last.endMs, current.endMs);
        } else {
            merged.push({ ...current });
        }
    }

    return merged;
}

function getIntervalsDurationMs(intervals: SpeedInterval[]): number {
    return intervals.reduce((total, interval) => total + (interval.endMs - interval.startMs), 0);
}

function createEmptySpeedMetrics(): SpeedMetrics {
    return {
        totalDurationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requestCount: 0
    };
}

function normalizeWindowSeconds(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }

    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
}

function collectSpeedMetricsFromLines(lines: string[], ignoreSidechain: boolean): CollectedSpeedMetrics {
    const requests: SpeedRequest[] = [];

    let lastUserTimestamp: Date | null = null;
    let latestTimestampMs: number | null = null;

    for (const line of lines) {
        const data = parseJsonlLine(line) as TranscriptLine | null;
        if (!data || data.isApiErrorMessage) {
            continue;
        }

        if (ignoreSidechain && data.isSidechain === true) {
            continue;
        }

        const entryTimestamp = parseTimestamp(data.timestamp);
        if (entryTimestamp) {
            const entryTimestampMs = entryTimestamp.getTime();
            if (latestTimestampMs === null || entryTimestampMs > latestTimestampMs) {
                latestTimestampMs = entryTimestampMs;
            }
        }

        if (data.type === 'user' && entryTimestamp) {
            lastUserTimestamp = entryTimestamp;
            continue;
        }

        if (data.type === 'assistant' && data.message?.usage) {
            const inputTokens = data.message.usage.input_tokens || 0;
            const outputTokens = data.message.usage.output_tokens || 0;
            let interval: SpeedInterval | null = null;
            if (entryTimestamp && lastUserTimestamp) {
                const startMs = lastUserTimestamp.getTime();
                const endMs = entryTimestamp.getTime();
                if (endMs > startMs) {
                    interval = { startMs, endMs };
                }
            }

            requests.push({
                inputTokens,
                outputTokens,
                assistantTimestampMs: entryTimestamp ? entryTimestamp.getTime() : null,
                interval
            });
        }
    }

    return {
        requests,
        latestTimestampMs
    };
}

function mergeCollectedSpeedMetrics(parts: CollectedSpeedMetrics[]): CollectedSpeedMetrics {
    const requests: SpeedRequest[] = [];
    let latestTimestampMs: number | null = null;

    for (const part of parts) {
        requests.push(...part.requests);

        if (part.latestTimestampMs !== null && (latestTimestampMs === null || part.latestTimestampMs > latestTimestampMs)) {
            latestTimestampMs = part.latestTimestampMs;
        }
    }

    return {
        requests,
        latestTimestampMs
    };
}

function buildSpeedMetrics(
    collected: CollectedSpeedMetrics,
    windowSeconds?: number
): SpeedMetrics {
    const normalizedWindowSeconds = normalizeWindowSeconds(windowSeconds);
    if (normalizedWindowSeconds !== null && collected.latestTimestampMs === null) {
        return createEmptySpeedMetrics();
    }

    const windowEndMs = normalizedWindowSeconds !== null && collected.latestTimestampMs !== null
        ? collected.latestTimestampMs
        : null;
    const windowStartMs = normalizedWindowSeconds !== null && windowEndMs !== null
        ? windowEndMs - (normalizedWindowSeconds * 1000)
        : null;

    const selectedRequests = normalizedWindowSeconds !== null && windowStartMs !== null && windowEndMs !== null
        ? collected.requests.filter(request => request.assistantTimestampMs !== null
            && request.assistantTimestampMs >= windowStartMs
            && request.assistantTimestampMs <= windowEndMs
        )
        : collected.requests;

    let inputTokens = 0;
    let outputTokens = 0;
    const intervals: SpeedInterval[] = [];

    for (const request of selectedRequests) {
        inputTokens += request.inputTokens;
        outputTokens += request.outputTokens;

        if (!request.interval) {
            continue;
        }

        if (windowStartMs === null || windowEndMs === null) {
            intervals.push(request.interval);
            continue;
        }

        const clippedStartMs = Math.max(request.interval.startMs, windowStartMs);
        const clippedEndMs = Math.min(request.interval.endMs, windowEndMs);
        if (clippedEndMs > clippedStartMs) {
            intervals.push({
                startMs: clippedStartMs,
                endMs: clippedEndMs
            });
        }
    }

    const mergedIntervals = mergeIntervals(intervals);
    const totalDurationMs = getIntervalsDurationMs(mergedIntervals);

    return {
        totalDurationMs,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        requestCount: selectedRequests.length
    };
}

function buildEmptyWindowedMetrics(windowSeconds: number[]): Record<string, SpeedMetrics> {
    const windowed: Record<string, SpeedMetrics> = {};
    for (const window of windowSeconds) {
        windowed[window.toString()] = createEmptySpeedMetrics();
    }
    return windowed;
}

export function getSubagentTranscriptPaths(transcriptPath: string, referencedAgentIds: Set<string>): string[] {
    if (referencedAgentIds.size === 0) {
        return [];
    }

    const transcriptDir = path.dirname(transcriptPath);
    const transcriptStem = path.parse(transcriptPath).name;
    const candidateDirs = [
        path.join(transcriptDir, 'subagents'),
        path.join(transcriptDir, transcriptStem, 'subagents')
    ];
    const seenPaths = new Set<string>();
    const matchedPaths: string[] = [];

    for (const subagentsDir of candidateDirs) {
        if (!fs.existsSync(subagentsDir)) {
            continue;
        }

        try {
            const dirEntries = fs.readdirSync(subagentsDir, { withFileTypes: true });
            for (const entry of dirEntries) {
                if (!entry.isFile()) {
                    continue;
                }

                const match = /^agent-(.+)\.jsonl$/.exec(entry.name);
                if (!match?.[1]) {
                    continue;
                }

                if (!referencedAgentIds.has(match[1])) {
                    continue;
                }

                const fullPath = path.join(subagentsDir, entry.name);
                if (seenPaths.has(fullPath)) {
                    continue;
                }

                seenPaths.add(fullPath);
                matchedPaths.push(fullPath);
            }
        } catch {
            continue;
        }
    }

    return matchedPaths;
}

export async function getSpeedMetricsCollection(
    transcriptPath: string,
    options: SpeedMetricsCollectionOptions = {}
): Promise<SpeedMetricsCollection> {
    const normalizedWindows = Array.from(
        new Set(
            (options.windowSeconds ?? [])
                .map(window => normalizeWindowSeconds(window))
                .filter((window): window is number => window !== null)
        )
    );
    const emptyWindowedMetrics = buildEmptyWindowedMetrics(normalizedWindows);

    try {
        if (!fs.existsSync(transcriptPath)) {
            return {
                sessionAverage: createEmptySpeedMetrics(),
                windowed: emptyWindowedMetrics
            };
        }

        const mainLines = await readJsonlLines(transcriptPath);
        const allCollected: CollectedSpeedMetrics[] = [
            collectSpeedMetricsFromLines(mainLines, true)
        ];

        if (options.includeSubagents === true) {
            const referencedSubagentIds = getReferencedSubagentIds(mainLines);
            const subagentPaths = getSubagentTranscriptPaths(transcriptPath, referencedSubagentIds);
            const subagentMetricsResults = await Promise.all(subagentPaths.map(async (subagentPath) => {
                try {
                    const subagentLines = await readJsonlLines(subagentPath);
                    return collectSpeedMetricsFromLines(subagentLines, false);
                } catch {
                    return null;
                }
            }));

            for (const subagentMetrics of subagentMetricsResults) {
                if (!subagentMetrics) {
                    continue;
                }

                allCollected.push(subagentMetrics);
            }
        }

        const combined = mergeCollectedSpeedMetrics(allCollected);
        const windowed: Record<string, SpeedMetrics> = {};
        for (const window of normalizedWindows) {
            windowed[window.toString()] = buildSpeedMetrics(combined, window);
        }

        return {
            sessionAverage: buildSpeedMetrics(combined),
            windowed
        };
    } catch {
        return {
            sessionAverage: createEmptySpeedMetrics(),
            windowed: emptyWindowedMetrics
        };
    }
}

export async function getSpeedMetrics(
    transcriptPath: string,
    options: SpeedMetricsOptions = {}
): Promise<SpeedMetrics> {
    const requestedWindow = normalizeWindowSeconds(options.windowSeconds);
    const metricsCollection = await getSpeedMetricsCollection(transcriptPath, {
        includeSubagents: options.includeSubagents,
        windowSeconds: requestedWindow ? [requestedWindow] : []
    });

    if (requestedWindow === null) {
        return metricsCollection.sessionAverage;
    }

    return metricsCollection.windowed[requestedWindow.toString()] ?? createEmptySpeedMetrics();
}
