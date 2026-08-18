import {
    describe,
    expect,
    it
} from 'vitest';

import type { RenderContext } from '../../types';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import type {
    ModelTokenBucketMap,
    TokenBucket
} from '../../types/TokenMetrics';
import type { WidgetItem } from '../../types/Widget';
import { ReCostWidget } from '../ReCost';

const widget = new ReCostWidget();

const item = (metadata?: Record<string, string>): WidgetItem => ({
    id: 'recost',
    type: 'recost',
    rawValue: true,
    ...(metadata ? { metadata } : {})
});

const bucket = (partial: Partial<TokenBucket> = {}): TokenBucket => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    ...partial
});

// 1M Opus output tokens = $75.00, a value that is easy to read back out of the render.
const opusOutput = (tokens: number): ModelTokenBucketMap => ({ 'claude-opus-4-8': { standard: bucket({ outputTokens: tokens }), longContext: bucket() } });

const context = (overrides: Partial<RenderContext> = {}): RenderContext => ({
    data: { cost: { total_cost_usd: 0 } },
    tokenMetrics: {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        contextLength: 0,
        byModel: opusOutput(1_000_000)
    },
    ...overrides
});

const render = (ctx: RenderContext, widgetItem = item()): string | null => widget.render(widgetItem, ctx, DEFAULT_SETTINGS);

describe('ReCost widget', () => {
    it('passes through a non-zero reported cost untouched', () => {
        const ctx = context({ data: { cost: { total_cost_usd: 3.5 } } });

        expect(render(ctx)).toBe('$3.50');
    });

    it('reconstructs the cost when Claude Code reports zero', () => {
        expect(render(context())).toBe('~$75.00');
    });

    it('reconstructs the cost when no cost field is present at all', () => {
        expect(render(context({ data: {} }))).toBe('~$75.00');
    });

    it('marks a reconstructed value so it reads as an estimate', () => {
        expect(render(context())).toMatch(/^~/);
    });

    it('ignores a reported cost when always-estimate is set', () => {
        const ctx = context({ data: { cost: { total_cost_usd: 3.5 } } });

        expect(render(ctx, item({ alwaysEstimate: 'true' }))).toBe('~$75.00');
    });

    it('adds subagent tokens to the estimate by default', () => {
        const ctx = context({ subagentModelBuckets: opusOutput(1_000_000) });

        expect(render(ctx)).toBe('~$150.00');
    });

    it('omits subagent tokens when they are excluded', () => {
        const ctx = context({ subagentModelBuckets: opusOutput(1_000_000) });

        expect(render(ctx, item({ excludeSubagents: 'true' }))).toBe('~$75.00');
    });

    it('flags an incomplete total when a model has no pricing entry', () => {
        const ctx = context({
            tokenMetrics: {
                inputTokens: 0,
                outputTokens: 0,
                cachedTokens: 0,
                totalTokens: 0,
                contextLength: 0,
                byModel: {
                    ...opusOutput(1_000_000),
                    'mystery-model-1': { standard: bucket({ outputTokens: 5000 }), longContext: bucket() }
                }
            }
        });

        expect(render(ctx)).toBe('~$75.00?');
    });

    it('renders n/a when the transcript yielded no usage', () => {
        expect(render(context({ tokenMetrics: null }))).toBe('n/a');
    });

    it('hides itself instead of rendering n/a when hide-when-zero is set', () => {
        const ctx = context({ tokenMetrics: null });

        expect(render(ctx, item({ hideWhenZero: 'true' }))).toBeNull();
    });

    it('labels the value when raw mode is off', () => {
        expect(widget.render({ id: 'recost', type: 'recost' }, context(), DEFAULT_SETTINGS)).toBe('Cost: ~$75.00');
    });

    it('exposes the estimate as a numeric value for thresholds', () => {
        expect(widget.getNumericValue(context(), item())).toBeCloseTo(75, 6);
    });
});
