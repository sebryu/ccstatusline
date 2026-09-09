import {
    describe,
    expect,
    it
} from 'vitest';

import type {
    ModelTokenBucketMap,
    TokenBucket
} from '../../types/TokenMetrics';
import {
    estimateCost,
    findModelRate,
    normalizeModelId
} from '../pricing';

const bucket = (partial: Partial<TokenBucket> = {}): TokenBucket => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    ...partial
});

const buckets = (standard: Partial<TokenBucket>, longContext: Partial<TokenBucket> = {}): ModelTokenBucketMap['x'] => ({
    standard: bucket(standard),
    longContext: bucket(longContext)
});

describe('normalizeModelId', () => {
    it('strips the context-variant suffix', () => {
        expect(normalizeModelId('claude-opus-5[1m]')).toBe('claude-opus-5');
    });

    it('lowercases the id', () => {
        expect(normalizeModelId('Claude-Sonnet-4-6')).toBe('claude-sonnet-4-6');
    });
});

describe('findModelRate', () => {
    it('resolves an unseen point release through its family prefix', () => {
        expect(findModelRate('claude-opus-4-8-20260101')?.inputPerMTok).toBe(5);
        expect(findModelRate('claude-haiku-4-5-20251001')?.outputPerMTok).toBe(5);
    });

    it('returns null for synthetic entries', () => {
        expect(findModelRate('<synthetic>')).toBeNull();
    });

    it('returns null for an unknown family', () => {
        expect(findModelRate('some-other-vendor-model')).toBeNull();
    });
});

describe('estimateCost', () => {
    it('prices plain input and output at the model rate', () => {
        const { costUSD } = estimateCost({ 'claude-opus-4-8': buckets({ inputTokens: 1_000_000, outputTokens: 1_000_000 }) });

        expect(costUSD).toBeCloseTo(30, 6);
    });

    it('prices cache reads at a tenth of the input rate', () => {
        const { costUSD } = estimateCost({ 'claude-opus-4-8': buckets({ cacheReadTokens: 1_000_000 }) });

        expect(costUSD).toBeCloseTo(0.5, 6);
    });

    it('charges a 1h cache write more than a 5m one', () => {
        const oneHour = estimateCost({ 'claude-opus-4-8': buckets({ cacheCreation1hTokens: 1_000_000 }) }).costUSD;
        const fiveMinute = estimateCost({ 'claude-opus-4-8': buckets({ cacheCreation5mTokens: 1_000_000 }) }).costUSD;

        expect(oneHour).toBeCloseTo(10, 6);
        expect(fiveMinute).toBeCloseTo(6.25, 6);
    });

    it('applies long-context rates to the long-context bucket', () => {
        const { costUSD } = estimateCost({ 'claude-sonnet-4-6': buckets({}, { inputTokens: 1_000_000 }) });

        expect(costUSD).toBeCloseTo(6, 6);
    });

    it('falls back to base rates when a model has no long-context tier', () => {
        const { costUSD } = estimateCost({ 'claude-opus-4-8': buckets({}, { inputTokens: 1_000_000 }) });

        expect(costUSD).toBeCloseTo(5, 6);
    });

    it('reports models it could not price instead of silently dropping them', () => {
        const { costUSD, unpricedModels } = estimateCost({
            'claude-opus-4-8': buckets({ inputTokens: 1_000_000 }),
            'mystery-model-1': buckets({ inputTokens: 1_000_000 })
        });

        expect(costUSD).toBeCloseTo(5, 6);
        expect(unpricedModels).toEqual(['mystery-model-1']);
    });

    it('ignores an unpriced model that carries no tokens', () => {
        const { unpricedModels } = estimateCost({ 'mystery-model-1': buckets({}) });

        expect(unpricedModels).toEqual([]);
    });
});
