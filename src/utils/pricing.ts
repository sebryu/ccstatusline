import * as fs from 'fs';
import os from 'node:os';
import path from 'node:path';

import type {
    ModelTokenBucketMap,
    TokenBucket
} from '../types/TokenMetrics';

/** Per-million-token list prices for one model at one pricing tier. */
export interface ModelRate {
    inputPerMTok: number;
    outputPerMTok: number;
    /** Rates applied to requests whose prompt crosses LONG_CONTEXT_THRESHOLD_TOKENS. */
    longContext?: { inputPerMTok: number; outputPerMTok: number };
}

export type PricingTable = Record<string, ModelRate>;

/**
 * Anthropic prices a prompt-cache write above the base input rate and a cache
 * read far below it. Both are expressed as multiples of the model's input rate.
 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

/** Requests with a prompt above this size bill at the model's long-context rates. */
export const LONG_CONTEXT_THRESHOLD_TOKENS = 200_000;

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Published list prices, keyed by a model-family prefix rather than an exact
 * model id so a new point release inherits its family's rate instead of
 * silently dropping to zero. Longest matching prefix wins.
 *
 * These are estimates: subscription plans are not billed per token, and any
 * negotiated rate is invisible here. Override per machine by writing a
 * partial table to ~/.config/ccstatusline/pricing.json.
 */
const DEFAULT_PRICING: PricingTable = {
    // Opus 4.6 and later dropped to a third of the Opus 4.1 rate and bill their
    // 1M context at the standard rate, so each of those families needs its own
    // entry rather than inheriting the legacy 'claude-opus' price.
    'claude-opus': { inputPerMTok: 15, outputPerMTok: 75 },
    'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
    'claude-sonnet': {
        inputPerMTok: 3,
        outputPerMTok: 15,
        longContext: { inputPerMTok: 6, outputPerMTok: 22.5 }
    },
    'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
    'claude-haiku': { inputPerMTok: 1, outputPerMTok: 5 }
};

/** Model ids that carry no billable tokens of their own. */
const NON_BILLABLE_MODELS = new Set(['<synthetic>', 'synthetic', '']);

let cachedPricingTable: PricingTable | null = null;

export function getPricingOverridePath(): string {
    return path.join(os.homedir(), '.config', 'ccstatusline', 'pricing.json');
}

function readPricingOverride(): PricingTable {
    try {
        const overridePath = getPricingOverridePath();
        if (!fs.existsSync(overridePath)) {
            return {};
        }

        const parsed = JSON.parse(fs.readFileSync(overridePath, 'utf-8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }

        const table: PricingTable = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!value || typeof value !== 'object') {
                continue;
            }

            const candidate = value as Record<string, unknown>;
            const inputPerMTok = candidate.inputPerMTok;
            const outputPerMTok = candidate.outputPerMTok;
            if (typeof inputPerMTok !== 'number' || typeof outputPerMTok !== 'number') {
                continue;
            }

            const rate: ModelRate = { inputPerMTok, outputPerMTok };
            const longContext = candidate.longContext;
            if (longContext && typeof longContext === 'object') {
                const long = longContext as Record<string, unknown>;
                if (typeof long.inputPerMTok === 'number' && typeof long.outputPerMTok === 'number') {
                    rate.longContext = { inputPerMTok: long.inputPerMTok, outputPerMTok: long.outputPerMTok };
                }
            }

            table[key.toLowerCase()] = rate;
        }

        return table;
    } catch {
        // A malformed override must not break the status line - fall back to defaults.
        return {};
    }
}

export function getPricingTable(): PricingTable {
    cachedPricingTable ??= { ...DEFAULT_PRICING, ...readPricingOverride() };
    return cachedPricingTable;
}

/** Test seam: drops the memoized table so a fresh override is picked up. */
export function resetPricingTableCache(): void {
    cachedPricingTable = null;
}

/**
 * Strips the context-variant suffix Claude Code appends to model ids
 * (`claude-opus-5[1m]` -> `claude-opus-5`).
 */
export function normalizeModelId(modelId: string): string {
    return modelId.toLowerCase().replace(/\[[^\]]*\]$/, '');
}

export function findModelRate(modelId: string, table: PricingTable = getPricingTable()): ModelRate | null {
    const normalized = normalizeModelId(modelId);
    if (NON_BILLABLE_MODELS.has(normalized)) {
        return null;
    }

    const exact = table[normalized];
    if (exact) {
        return exact;
    }

    let bestPrefix = '';
    for (const prefix of Object.keys(table)) {
        if (normalized.startsWith(prefix) && prefix.length > bestPrefix.length) {
            bestPrefix = prefix;
        }
    }

    return bestPrefix ? (table[bestPrefix] ?? null) : null;
}

function priceBucket(bucket: TokenBucket, inputPerMTok: number, outputPerMTok: number): number {
    const inputCost = bucket.inputTokens * inputPerMTok;
    const outputCost = bucket.outputTokens * outputPerMTok;
    const cacheReadCost = bucket.cacheReadTokens * inputPerMTok * CACHE_READ_MULTIPLIER;
    const cacheWrite5mCost = bucket.cacheCreation5mTokens * inputPerMTok * CACHE_WRITE_5M_MULTIPLIER;
    const cacheWrite1hCost = bucket.cacheCreation1hTokens * inputPerMTok * CACHE_WRITE_1H_MULTIPLIER;

    return (inputCost + outputCost + cacheReadCost + cacheWrite5mCost + cacheWrite1hCost) / TOKENS_PER_MILLION;
}

export interface CostEstimate {
    costUSD: number;
    /** Model ids with billable tokens that no pricing entry matched. */
    unpricedModels: string[];
}

/**
 * Prices per-model token buckets. Models missing from the table contribute
 * nothing to the total and are reported in `unpricedModels` so callers can
 * mark the estimate as incomplete rather than quietly under-reporting.
 */
export function estimateCost(byModel: ModelTokenBucketMap, table: PricingTable = getPricingTable()): CostEstimate {
    let costUSD = 0;
    const unpricedModels: string[] = [];

    for (const [modelId, buckets] of Object.entries(byModel)) {
        const rate = findModelRate(modelId, table);
        if (!rate) {
            const normalized = normalizeModelId(modelId);
            if (!NON_BILLABLE_MODELS.has(normalized) && bucketHasTokens(buckets.standard, buckets.longContext)) {
                unpricedModels.push(modelId);
            }
            continue;
        }

        costUSD += priceBucket(buckets.standard, rate.inputPerMTok, rate.outputPerMTok);

        const longRate = rate.longContext ?? rate;
        costUSD += priceBucket(buckets.longContext, longRate.inputPerMTok, longRate.outputPerMTok);
    }

    return { costUSD, unpricedModels };
}

function bucketHasTokens(...buckets: TokenBucket[]): boolean {
    return buckets.some(bucket => bucket.inputTokens > 0
        || bucket.outputTokens > 0
        || bucket.cacheReadTokens > 0
        || bucket.cacheCreation5mTokens > 0
        || bucket.cacheCreation1hTokens > 0);
}
