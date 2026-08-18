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

import type { RenderContext } from '../../types';
import { DEFAULT_SETTINGS } from '../../types/Settings';
import type { WidgetItem } from '../../types/Widget';
import { CacheTimerWidget } from '../CacheTimer';

const item = (extra: Partial<WidgetItem> = {}): WidgetItem => ({ id: 'cache-timer', type: 'cache-timer', ...extra });
const hidden: Partial<WidgetItem> = { metadata: { hideWhenEmpty: 'true' } };

const isoAgo = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();
const assistant = (seconds: number): string => JSON.stringify({ type: 'assistant', timestamp: isoAgo(seconds) });
const pendingUser = JSON.stringify({ type: 'user' });
const sidechain = (type: string, seconds: number): string => JSON.stringify({ type, timestamp: isoAgo(seconds), isSidechain: true });
const apiError = (seconds: number): string => JSON.stringify({ type: 'assistant', timestamp: isoAgo(seconds), isApiErrorMessage: true });
const assistantUsage = (seconds: number, usage: object): string => JSON.stringify({ type: 'assistant', timestamp: isoAgo(seconds), message: { usage } });
const noCacheUsage = { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

// User rows Claude Code writes locally, with no request behind them.
const localUser = (content: string, extra: object = {}): string => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content }, ...extra });
const slashCommand = localUser('<command-name>/clear</command-name>\n            <command-message>clear</command-message>');
// Claude Code flipped the tag order: newer echoes lead with <command-message>.
const slashCommandNewOrder = localUser('<command-message>review</command-message>\n<command-name>/review</command-name>');
const commandStdout = localUser('<local-command-stdout>Set model to Opus</local-command-stdout>');
const commandCaveat = localUser('<local-command-caveat>Caveat: the messages below were generated while running local commands.</local-command-caveat>', { isMeta: true });
const bashInput = localUser('<bash-input>git status</bash-input>');
const bashStdout = localUser('<bash-stdout>On branch dev</bash-stdout><bash-stderr></bash-stderr>');
const contextUsage = localUser('## Context Usage\n- System prompt: 2.4k tokens', { isMeta: true });
const compactSummary = localUser('This session is being continued from a previous conversation...', { isCompactSummary: true, isVisibleInTranscriptOnly: true });
const transcriptOnly = localUser('rendered locally', { isVisibleInTranscriptOnly: true });
const systemRow = (subtype: string, seconds: number): string => JSON.stringify({ type: 'system', subtype, isSidechain: false, timestamp: isoAgo(seconds) });
// A genuine pending tool result: role 'user', but content blocks, not a string.
const blockUser = (blocks: object[], extra: object = {}): string => JSON.stringify({ type: 'user', message: { role: 'user', content: blocks }, ...extra });
const toolResult = blockUser([{ tool_use_id: 't1', type: 'tool_result', content: 'ok' }]);
const interrupted = blockUser([{ type: 'text', text: '[Request interrupted by user]' }]);
const interruptedForToolUse = blockUser([{ type: 'text', text: '[Request interrupted by user for tool use]' }]);

describe('CacheTimer widget', () => {
    let tmpDir: string;
    let fileCounter = 0;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstatusline-cache-timer-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const transcriptContext = (lines: string[]): RenderContext => {
        const file = path.join(tmpDir, `transcript-${++fileCounter}.jsonl`);
        fs.writeFileSync(file, lines.join('\n'), 'utf8');
        return { data: { transcript_path: file } };
    };

    it('renders the preview as a labeled or raw sample', () => {
        const widget = new CacheTimerWidget();
        expect(widget.render(item(), { isPreview: true }, DEFAULT_SETTINGS)).toBe('Cache: 🟢 4:52');
        expect(widget.render(item({ rawValue: true }), { isPreview: true }, DEFAULT_SETTINGS)).toBe('🟢 4:52');
    });

    it('renders n/a when no transcript is available by default', () => {
        const widget = new CacheTimerWidget();
        expect(widget.render(item(), {}, DEFAULT_SETTINGS)).toBe('Cache: n/a');
        expect(widget.render(item({ rawValue: true }), {}, DEFAULT_SETTINGS)).toBe('n/a');
    });

    it('hides the widget when there is no data and hide-when-empty is enabled', () => {
        const widget = new CacheTimerWidget();
        expect(widget.render(item(hidden), {}, DEFAULT_SETTINGS)).toBeNull();
        expect(widget.render(item(hidden), transcriptContext([]), DEFAULT_SETTINGS)).toBeNull();
    });

    it('renders n/a for an empty transcript by default', () => {
        const widget = new CacheTimerWidget();
        expect(widget.render(item(), transcriptContext([]), DEFAULT_SETTINGS)).toBe('Cache: n/a');
    });

    it('shows HOT while a turn is in flight, regardless of hide-when-empty', () => {
        const widget = new CacheTimerWidget();
        const context = transcriptContext([assistant(60), pendingUser]);
        expect(widget.render(item(), context, DEFAULT_SETTINGS)).toBe('Cache: 🔥 HOT');
        expect(widget.render(item(hidden), context, DEFAULT_SETTINGS)).toBe('Cache: 🔥 HOT');
    });

    const buckets = [
        { label: 'fresh', elapsed: 10, icon: '🟢' },
        { label: 'draining', elapsed: 180, icon: '🟡' },
        { label: 'almost cold', elapsed: 260, icon: '🔴' }
    ];
    for (const { label, elapsed, icon } of buckets) {
        it(`renders the ${label} countdown with the ${icon} icon`, () => {
            const widget = new CacheTimerWidget();
            const out = widget.render(item(), transcriptContext([assistant(elapsed)]), DEFAULT_SETTINGS);
            expect(out).toMatch(new RegExp(`^Cache: ${icon} \\d+:\\d{2}$`));
        });
    }

    it('renders COLD once the TTL has elapsed', () => {
        const widget = new CacheTimerWidget();
        expect(widget.render(item(), transcriptContext([assistant(400)]), DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
    });

    it('renders a raw countdown without the label', () => {
        const widget = new CacheTimerWidget();
        const out = widget.render(item({ rawValue: true }), transcriptContext([assistant(10)]), DEFAULT_SETTINGS);
        expect(out).toMatch(/^🟢 \d+:\d{2}$/);
    });

    it('ignores sidechain rows when deriving the cache state', () => {
        const widget = new CacheTimerWidget();
        // A trailing sidechain user row must not report HOT...
        expect(widget.render(item(), transcriptContext([assistant(400), sidechain('user', 5)]), DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
        // ...and a trailing sidechain assistant row must not restart the countdown.
        expect(widget.render(item(), transcriptContext([assistant(400), sidechain('assistant', 5)]), DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
    });

    it('ignores synthetic API-error rows when deriving the cache state', () => {
        const widget = new CacheTimerWidget();
        // A failed request refreshes nothing, so the prior event still drives the countdown...
        expect(widget.render(item(), transcriptContext([assistant(400), apiError(5)]), DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
        // ...and with no prior main-chain row there is no cache event to report.
        expect(widget.render(item(), transcriptContext([apiError(5)]), DEFAULT_SETTINGS)).toBe('Cache: n/a');
    });

    it('skips assistant rows whose request had no cache activity', () => {
        const widget = new CacheTimerWidget();
        // The prior row that actually touched the cache still drives the countdown...
        const cached = assistantUsage(400, { cache_read_input_tokens: 100, cache_creation_input_tokens: 0 });
        expect(widget.render(item(), transcriptContext([cached, assistantUsage(10, noCacheUsage)]), DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
        // ...and when caching never happened at all there is nothing to count down.
        expect(widget.render(item(), transcriptContext([assistantUsage(10, noCacheUsage)]), DEFAULT_SETTINGS)).toBe('Cache: n/a');
    });

    it('does not report HOT for a finished turn whose response had no cache activity', () => {
        const widget = new CacheTimerWidget();
        // The user row that started the turn precedes the zero-cache response,
        // as in a real transcript; the finished turn must not read as in-flight.
        expect(widget.render(item(), transcriptContext([pendingUser, assistantUsage(10, noCacheUsage)]), DEFAULT_SETTINGS)).toBe('Cache: n/a');
        // An older cache event still drives the countdown instead.
        const cached = assistantUsage(400, { cache_read_input_tokens: 100, cache_creation_input_tokens: 0 });
        expect(widget.render(item(), transcriptContext([cached, pendingUser, assistantUsage(10, noCacheUsage)]), DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
    });

    it('does not report HOT for a turn that ended in an API error', () => {
        const widget = new CacheTimerWidget();
        expect(widget.render(item(), transcriptContext([pendingUser, apiError(5)]), DEFAULT_SETTINGS)).toBe('Cache: n/a');
        expect(widget.render(item(), transcriptContext([assistant(400), pendingUser, apiError(5)]), DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
    });

    it('starts the countdown from rows with cache reads or cache writes', () => {
        const widget = new CacheTimerWidget();
        expect(widget.render(item(), transcriptContext([assistantUsage(10, { cache_read_input_tokens: 1234 })]), DEFAULT_SETTINGS)).toMatch(/^Cache: 🟢 \d+:\d{2}$/);
        expect(widget.render(item(), transcriptContext([assistantUsage(10, { cache_creation_input_tokens: 55 })]), DEFAULT_SETTINGS)).toMatch(/^Cache: 🟢 \d+:\d{2}$/);
    });

    it('finds the trailing record even when it exceeds the initial 32 KiB tail read', () => {
        const widget = new CacheTimerWidget();
        // A pending user row bigger than the initial tail (e.g. a pasted prompt
        // or large tool result) must still report HOT...
        const bigUser = JSON.stringify({ type: 'user', content: 'x'.repeat(64 * 1024) });
        expect(widget.render(item(), transcriptContext([assistant(400), bigUser]), DEFAULT_SETTINGS)).toBe('Cache: 🔥 HOT');
        // ...and an oversized trailing assistant row must still drive the countdown.
        const bigAssistant = JSON.stringify({ type: 'assistant', timestamp: isoAgo(10), content: 'x'.repeat(64 * 1024) });
        expect(widget.render(item(), transcriptContext([bigAssistant]), DEFAULT_SETTINGS)).toMatch(/^Cache: 🟢 \d+:\d{2}$/);
    });

    it('finds a valid trailing record larger than 1 MiB', () => {
        const widget = new CacheTimerWidget();
        const huge = JSON.stringify({ type: 'assistant', timestamp: isoAgo(10), message: { usage: { cache_read_input_tokens: 42 } }, content: 'x'.repeat(2 * 1024 * 1024) });
        expect(widget.render(item(), transcriptContext([huge]), DEFAULT_SETTINGS)).toMatch(/^Cache: 🟢 \d+:\d{2}$/);
    });

    it('renders n/a after scanning a file with no parseable records', () => {
        const widget = new CacheTimerWidget();
        expect(widget.render(item(), transcriptContext(['x'.repeat(2 * 1024 * 1024)]), DEFAULT_SETTINGS)).toBe('Cache: n/a');
    });

    it('treats a malformed assistant timestamp as no data instead of rendering NaN', () => {
        const widget = new CacheTimerWidget();
        const context = transcriptContext([JSON.stringify({ type: 'assistant', timestamp: 'not-a-date' })]);
        expect(widget.render(item(), context, DEFAULT_SETTINGS)).toBe('Cache: n/a');
        expect(widget.render(item(hidden), context, DEFAULT_SETTINGS)).toBeNull();
    });

    it('exposes a hide-when-empty keybind and toggles the flag', () => {
        const widget = new CacheTimerWidget();
        expect(widget.getCustomKeybinds()).toEqual([
            { key: 't', label: '(t)tl', action: 'toggle-ttl' },
            { key: 'h', label: '(h)ide when empty', action: 'toggle-hide' },
            { key: 'g', label: '(g)lyph', action: 'edit-symbol-override' }
        ]);
        expect(widget.handleEditorAction('toggle-hide', item())?.metadata?.hideWhenEmpty).toBe('true');
        expect(widget.handleEditorAction('unknown', item())).toBeNull();
    });

    it('annotates the editor only when hide-when-empty is enabled', () => {
        const widget = new CacheTimerWidget();
        expect(widget.getEditorDisplay(item()).displayText).toBe('Cache Timer');
        expect(widget.getEditorDisplay(item()).modifierText).toBeUndefined();
        expect(widget.getEditorDisplay(item(hidden)).modifierText).toBe('(hide when empty)');
    });

    it('renders custom state glyphs from metadata overrides', () => {
        const widget = new CacheTimerWidget();
        expect(widget.render(item({ metadata: { symbolCold: 'X' } }), transcriptContext([assistant(400)]), DEFAULT_SETTINGS)).toBe('Cache: X COLD');
        expect(widget.render(item({ metadata: { symbolFresh: '*' } }), transcriptContext([assistant(10)]), DEFAULT_SETTINGS)).toMatch(/^Cache: \* \d+:\d{2}$/);
        expect(widget.render(item({ metadata: { symbolHot: '>' } }), transcriptContext([assistant(60), pendingUser]), DEFAULT_SETTINGS)).toBe('Cache: > HOT');
    });

    it('drops the glyph and its space when an override is blanked', () => {
        const widget = new CacheTimerWidget();
        expect(widget.render(item({ metadata: { symbolFresh: '' } }), transcriptContext([assistant(10)]), DEFAULT_SETTINGS)).toMatch(/^Cache: \d+:\d{2}$/);
    });

    it('reflects a custom fresh glyph in the preview', () => {
        const widget = new CacheTimerWidget();
        expect(widget.render(item({ metadata: { symbolFresh: '#' } }), { isPreview: true }, DEFAULT_SETTINGS)).toBe('Cache: # 4:52');
    });

    it('extends the countdown window when the TTL is set to 1 hour', () => {
        const widget = new CacheTimerWidget();
        // 600s in is COLD at the default 5-minute TTL...
        expect(widget.render(item(), transcriptContext([assistant(600)]), DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
        // ...but still fresh under a 1-hour TTL.
        expect(widget.render(item({ metadata: { ttlSeconds: '3600' } }), transcriptContext([assistant(600)]), DEFAULT_SETTINGS)).toMatch(/^Cache: 🟢 \d+:\d{2}$/);
    });

    it('falls back to the default TTL for a malformed value', () => {
        const widget = new CacheTimerWidget();
        expect(widget.render(item({ metadata: { ttlSeconds: 'abc' } }), transcriptContext([assistant(600)]), DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
    });

    it('cycles the TTL between 5m and 1h via the keybind', () => {
        const widget = new CacheTimerWidget();
        const toOneHour = widget.handleEditorAction('toggle-ttl', item());
        expect(toOneHour?.metadata?.ttlSeconds).toBe('3600');
        const backToDefault = widget.handleEditorAction('toggle-ttl', toOneHour ?? item());
        expect(backToDefault?.metadata?.ttlSeconds).toBeUndefined();
    });

    it('annotates the editor with a non-default TTL', () => {
        const widget = new CacheTimerWidget();
        expect(widget.getEditorDisplay(item({ metadata: { ttlSeconds: '3600' } })).modifierText).toBe('(ttl 1h)');
        expect(widget.getEditorDisplay(item({ metadata: { ttlSeconds: '3600', hideWhenEmpty: 'true' } })).modifierText).toBe('(ttl 1h, hide when empty)');
    });

    describe('local-only rows', () => {
        const localRows = [
            { label: 'a slash-command echo', line: slashCommand },
            { label: 'a slash-command echo in the newer tag order', line: slashCommandNewOrder },
            { label: 'captured command output', line: commandStdout },
            { label: 'a local-command caveat', line: commandCaveat },
            { label: 'a bash-mode input echo', line: bashInput },
            { label: 'bash-mode output', line: bashStdout },
            { label: 'the context-usage report', line: contextUsage },
            { label: 'a compaction summary', line: compactSummary },
            { label: 'a transcript-only row', line: transcriptOnly }
        ];

        for (const { label, line } of localRows) {
            it(`does not report HOT for ${label}`, () => {
                const widget = new CacheTimerWidget();
                expect(widget.render(item(), transcriptContext([assistant(400), line]), DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
            });
        }

        it('scans past a whole stack of local rows to the last real cache event', () => {
            const widget = new CacheTimerWidget();
            const context = transcriptContext([assistant(400), ...localRows.map(r => r.line)]);
            expect(widget.render(item(), context, DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
        });

        it('stays cold through the row sequence a real /compact leaves behind', () => {
            const widget = new CacheTimerWidget();
            const cached = assistantUsage(400, { cache_read_input_tokens: 100, cache_creation_input_tokens: 0 });
            const context = transcriptContext([cached, systemRow('compact_boundary', 5), compactSummary, commandCaveat, slashCommand]);
            expect(widget.render(item(), context, DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
        });

        it('does not restart a live countdown', () => {
            const widget = new CacheTimerWidget();
            expect(widget.render(item(), transcriptContext([assistant(10), slashCommand]), DEFAULT_SETTINGS)).toMatch(/^Cache: 🟢 \d+:\d{2}$/);
        });

        it('still reports HOT for a pending tool result', () => {
            const widget = new CacheTimerWidget();
            expect(widget.render(item(), transcriptContext([assistant(400), toolResult]), DEFAULT_SETTINGS)).toBe('Cache: 🔥 HOT');
        });

        it('still reports HOT for a real prompt sitting under a local row', () => {
            const widget = new CacheTimerWidget();
            expect(widget.render(item(), transcriptContext([assistant(400), slashCommand, pendingUser]), DEFAULT_SETTINGS)).toBe('Cache: 🔥 HOT');
            expect(widget.render(item(), transcriptContext([assistant(400), pendingUser, commandStdout]), DEFAULT_SETTINGS)).toBe('Cache: 🔥 HOT');
        });

        it('neither anchors the countdown nor reports HOT for system rows', () => {
            const widget = new CacheTimerWidget();
            expect(widget.render(item(), transcriptContext([assistant(400), systemRow('compact_boundary', 5)]), DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
        });

        it('reports no data when local rows are all there is', () => {
            const widget = new CacheTimerWidget();
            const context = transcriptContext([slashCommand, commandStdout, compactSummary]);
            expect(widget.render(item(), context, DEFAULT_SETTINGS)).toBe('Cache: n/a');
            expect(widget.render(item(hidden), context, DEFAULT_SETTINGS)).toBeNull();
        });

        it('keeps resolving the TTL across skipped rows', () => {
            const widget = new CacheTimerWidget();
            const context = transcriptContext([assistant(600), slashCommand, commandStdout]);
            expect(widget.render(item({ metadata: { ttlSeconds: '3600' } }), context, DEFAULT_SETTINGS)).toMatch(/^Cache: 🟢 \d+:\d{2}$/);
        });

        it('skips a local row that exceeds the initial 32 KiB tail read', () => {
            const widget = new CacheTimerWidget();
            const bigStdout = localUser(`<local-command-stdout>${'x'.repeat(64 * 1024)}</local-command-stdout>`);
            expect(widget.render(item(), transcriptContext([assistant(10), bigStdout]), DEFAULT_SETTINGS)).toMatch(/^Cache: 🟢 \d+:\d{2}$/);
        });
    });

    describe('interrupted turns', () => {
        for (const [label, line] of [['a plain interrupt', interrupted], ['a tool-use interrupt', interruptedForToolUse]] as const) {
            it(`ends the turn on ${label}`, () => {
                const widget = new CacheTimerWidget();
                expect(widget.render(item(), transcriptContext([assistant(400), line]), DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
            });
        }

        it('ends the turn for the tool_result the interrupt cut short', () => {
            const widget = new CacheTimerWidget();
            // The interrupted tool_result sits directly above the marker; a scan
            // that merely skipped the marker would still report HOT for it.
            const context = transcriptContext([assistant(400), toolResult, interrupted]);
            expect(widget.render(item(), context, DEFAULT_SETTINGS)).toBe('Cache: ❄️ COLD');
        });

        it('does not restart a live countdown', () => {
            const widget = new CacheTimerWidget();
            expect(widget.render(item(), transcriptContext([assistant(10), toolResult, interrupted]), DEFAULT_SETTINGS)).toMatch(/^Cache: 🟢 \d+:\d{2}$/);
        });

        it('reports HOT again once a new prompt follows the interrupt', () => {
            const widget = new CacheTimerWidget();
            expect(widget.render(item(), transcriptContext([assistant(400), interrupted, pendingUser]), DEFAULT_SETTINGS)).toBe('Cache: 🔥 HOT');
        });
    });

    // Every row here is sent to the API and gets a real response, so the widget
    // must report HOT. isMeta marks a row the human did not type, which is not
    // the same as a row that never left the machine — these are the guards
    // against filtering on it.
    describe('rows that only look local', () => {
        const stillHot = [
            { label: 'a skill invocation', line: blockUser([{ type: 'text', text: 'Base directory for this skill: /Users/x/.claude/skills/demo' }], { isMeta: true }) },
            { label: 'an autonomous-loop wakeup', line: localUser('<<autonomous-loop-dynamic>>', { isMeta: true }) },
            { label: 'a cross-session teammate message', line: localUser('Another Claude session sent a message:\n<agent-message from="peer">hi</agent-message>', { isMeta: true }) },
            { label: 'a Stop-hook goal prompt', line: localUser('A session-scoped Stop hook is now active with condition: finish the task', { isMeta: true }) },
            { label: 'a pasted image', line: localUser('[Image: original 3840x2160, resized to 1092x614]', { isMeta: true }) },
            { label: 'a pending tool result', line: toolResult },
            { label: 'a prompt quoting a command tag mid-string', line: localUser(`why does ${'-'.repeat(2988)}<command-name> appear in my transcript?`) },
            { label: 'a tool result quoting a caveat tag', line: blockUser([{ tool_use_id: 't1', type: 'tool_result', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' }]) }
        ];

        for (const { label, line } of stillHot) {
            it(`still reports HOT for ${label}`, () => {
                const widget = new CacheTimerWidget();
                expect(widget.render(item(), transcriptContext([assistant(400), line]), DEFAULT_SETTINGS)).toBe('Cache: 🔥 HOT');
            });
        }
    });
});
