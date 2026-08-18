import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import { getTokenMetrics } from '../jsonl-metrics';

interface UsageOverrides {
    model?: string;
    requestId?: string;
    stop_reason?: string | null;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

const assistantLine = (overrides: UsageOverrides = {}): string => {
    const {
        model = 'claude-opus-4-8',
        stop_reason = 'end_turn',
        requestId,
        ...usage
    } = overrides;

    return JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        ...(requestId ? { requestId } : {}),
        message: {
            model,
            stop_reason,
            usage: { input_tokens: 0, output_tokens: 0, ...usage }
        }
    });
};

describe('getTokenMetrics byModel', () => {
    let tmpDir: string;
    let fileCounter = 0;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-bymodel-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const write = (lines: string[]): string => {
        const file = path.join(tmpDir, `transcript-${++fileCounter}.jsonl`);
        fs.writeFileSync(file, lines.join('\n'), 'utf8');
        return file;
    };

    it('buckets tokens per model', async () => {
        const file = write([
            assistantLine({ model: 'claude-opus-4-8', output_tokens: 100 }),
            assistantLine({ model: 'claude-haiku-4-5-20251001', output_tokens: 40 })
        ]);

        const { byModel } = await getTokenMetrics(file);

        expect(byModel?.['claude-opus-4-8']?.standard.outputTokens).toBe(100);
        expect(byModel?.['claude-haiku-4-5-20251001']?.standard.outputTokens).toBe(40);
    });

    it('counts one API request once however many content blocks it emitted', async () => {
        // Four parallel tool calls write four lines, each repeating the request's full usage.
        const file = write([
            assistantLine({ requestId: 'req_1', output_tokens: 50, stop_reason: 'tool_use' }),
            assistantLine({ requestId: 'req_1', output_tokens: 50, stop_reason: 'tool_use' }),
            assistantLine({ requestId: 'req_1', output_tokens: 50, stop_reason: 'tool_use' }),
            assistantLine({ requestId: 'req_1', output_tokens: 50, stop_reason: 'tool_use' })
        ]);

        const { byModel } = await getTokenMetrics(file);

        expect(byModel?.['claude-opus-4-8']?.standard.outputTokens).toBe(50);
    });

    it('keeps the finalized usage when a request streamed partials first', async () => {
        const file = write([
            assistantLine({ requestId: 'req_1', output_tokens: 10, stop_reason: null }),
            assistantLine({ requestId: 'req_1', output_tokens: 50, stop_reason: 'end_turn' })
        ]);

        const { byModel } = await getTokenMetrics(file);

        expect(byModel?.['claude-opus-4-8']?.standard.outputTokens).toBe(50);
    });

    it('sums separate requests', async () => {
        const file = write([
            assistantLine({ requestId: 'req_1', output_tokens: 50 }),
            assistantLine({ requestId: 'req_2', output_tokens: 20 })
        ]);

        const { byModel } = await getTokenMetrics(file);

        expect(byModel?.['claude-opus-4-8']?.standard.outputTokens).toBe(70);
    });

    it('counts entries individually when a transcript carries no requestId', async () => {
        const file = write([
            assistantLine({ output_tokens: 50 }),
            assistantLine({ output_tokens: 20 })
        ]);

        const { byModel } = await getTokenMetrics(file);

        expect(byModel?.['claude-opus-4-8']?.standard.outputTokens).toBe(70);
    });

    it('splits cache writes by TTL', async () => {
        const file = write([
            assistantLine({
                cache_creation_input_tokens: 300,
                cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 100 }
            })
        ]);

        const { byModel } = await getTokenMetrics(file);
        const standard = byModel?.['claude-opus-4-8']?.standard;

        expect(standard?.cacheCreation1hTokens).toBe(200);
        expect(standard?.cacheCreation5mTokens).toBe(100);
    });

    it('treats a TTL-less cache write as the cheaper 5m tier', async () => {
        const file = write([assistantLine({ cache_creation_input_tokens: 300 })]);

        const { byModel } = await getTokenMetrics(file);
        const standard = byModel?.['claude-opus-4-8']?.standard;

        expect(standard?.cacheCreation5mTokens).toBe(300);
        expect(standard?.cacheCreation1hTokens).toBe(0);
    });

    it('routes an oversized prompt into the long-context bucket', async () => {
        const file = write([
            assistantLine({ input_tokens: 10, cache_read_input_tokens: 250_000, output_tokens: 7 })
        ]);

        const { byModel } = await getTokenMetrics(file);

        expect(byModel?.['claude-opus-4-8']?.longContext.outputTokens).toBe(7);
        expect(byModel?.['claude-opus-4-8']?.standard.outputTokens).toBe(0);
    });

    it('skips entries with no model id', async () => {
        const file = write([JSON.stringify({
            type: 'assistant',
            message: { stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } }
        })]);

        const { byModel, outputTokens } = await getTokenMetrics(file);

        expect(byModel).toEqual({});
        expect(outputTokens).toBe(5);
    });

    it('counts sidechain turns, which are billed like any other', async () => {
        const file = write([
            assistantLine({ output_tokens: 20 }),
            JSON.stringify({
                type: 'assistant',
                isSidechain: true,
                timestamp: new Date().toISOString(),
                message: { model: 'claude-opus-4-8', stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 30 } }
            })
        ]);

        const { byModel } = await getTokenMetrics(file);

        expect(byModel?.['claude-opus-4-8']?.standard.outputTokens).toBe(50);
    });
});
