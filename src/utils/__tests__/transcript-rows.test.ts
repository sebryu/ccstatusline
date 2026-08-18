import {
    describe,
    expect,
    it
} from 'vitest';

import {
    isInterruptMarkerRow,
    isLocalOnlyUserRow
} from '../transcript-rows';

const userRow = (content: unknown, extra: object = {}) => ({ message: { role: 'user', content }, ...extra });

describe('isLocalOnlyUserRow', () => {
    it('matches the flags a compaction leaves on its summary', () => {
        expect(isLocalOnlyUserRow(userRow('summary', { isCompactSummary: true }))).toBe(true);
        expect(isLocalOnlyUserRow(userRow('rendered locally', { isVisibleInTranscriptOnly: true }))).toBe(true);
    });

    it('ignores flags that are present but not true', () => {
        expect(isLocalOnlyUserRow(userRow('hello', { isCompactSummary: false }))).toBe(false);
        expect(isLocalOnlyUserRow(userRow('hello', { isVisibleInTranscriptOnly: undefined }))).toBe(false);
    });

    it('matches every local-only tag at the start of string content', () => {
        const tags = [
            '<command-name>/clear</command-name>',
            '<command-message>review</command-message>\n<command-name>/review</command-name>',
            '<local-command-stdout>Set model to Opus</local-command-stdout>',
            '<local-command-caveat>Caveat: tool results below</local-command-caveat>',
            '<bash-input>git status</bash-input>',
            '<bash-stdout>On branch dev</bash-stdout>'
        ];
        for (const content of tags) {
            expect(isLocalOnlyUserRow(userRow(content))).toBe(true);
        }
    });

    it('tolerates leading whitespace before the tag', () => {
        expect(isLocalOnlyUserRow(userRow('\n  <command-name>/clear</command-name>'))).toBe(true);
    });

    it('does not match a tag that merely appears inside the content', () => {
        // A real prompt discussing these tags is still a real prompt.
        expect(isLocalOnlyUserRow(userRow('why does <local-command-stdout> show up in my transcript?'))).toBe(false);
    });

    it('never matches array content, even when a block quotes a tag', () => {
        // Tool results arrive as content blocks; one quoting a tag verbatim
        // must not be mistaken for a locally rendered row.
        const toolResult = userRow([{ tool_use_id: 't1', type: 'tool_result', content: '<local-command-stdout>x</local-command-stdout>' }]);
        expect(isLocalOnlyUserRow(toolResult)).toBe(false);
    });

    describe('isMeta', () => {
        it('matches only the context-usage report', () => {
            expect(isLocalOnlyUserRow(userRow('## Context Usage\n- System prompt: 2.4k', { isMeta: true }))).toBe(true);
        });

        it('does not qualify a row on its own', () => {
            // isMeta means "the human did not type this", not "this was never
            // sent". All of these get a real response.
            const sentAnyway = [
                userRow([{ type: 'text', text: 'Base directory for this skill: /Users/x/.claude/skills/demo' }], { isMeta: true }),
                userRow('<<autonomous-loop-dynamic>>', { isMeta: true }),
                userRow('Another Claude session sent a message:\n<agent-message from="peer">hi</agent-message>', { isMeta: true }),
                userRow('A session-scoped Stop hook is now active with condition: finish', { isMeta: true }),
                userRow('[Image: original 3840x2160, resized to 1092x614]', { isMeta: true })
            ];
            for (const row of sentAnyway) {
                expect(isLocalOnlyUserRow(row)).toBe(false);
            }
        });

        it('does not honour the context-usage body without the flag', () => {
            expect(isLocalOnlyUserRow(userRow('## Context Usage\n- System prompt: 2.4k'))).toBe(false);
        });
    });

    it('treats a plain prompt and a row with no content as real', () => {
        expect(isLocalOnlyUserRow(userRow('run the tests'))).toBe(false);
        expect(isLocalOnlyUserRow(userRow(undefined))).toBe(false);
        expect(isLocalOnlyUserRow({})).toBe(false);
    });
});

describe('isInterruptMarkerRow', () => {
    it('matches both interrupt markers as a leading text block', () => {
        expect(isInterruptMarkerRow(userRow([{ type: 'text', text: '[Request interrupted by user]' }]))).toBe(true);
        expect(isInterruptMarkerRow(userRow([{ type: 'text', text: '[Request interrupted by user for tool use]' }]))).toBe(true);
    });

    it('never matches a tool_result block', () => {
        const quoting = userRow([{ tool_use_id: 't1', type: 'tool_result', content: '[Request interrupted by user]' }]);
        expect(isInterruptMarkerRow(quoting)).toBe(false);
    });

    it('does not match string content or a mid-string mention', () => {
        expect(isInterruptMarkerRow(userRow('[Request interrupted by user]'))).toBe(false);
        expect(isInterruptMarkerRow(userRow([{ type: 'text', text: 'why do I see [Request interrupted by user]?' }]))).toBe(false);
    });

    it('tolerates empty and malformed content', () => {
        expect(isInterruptMarkerRow(userRow([]))).toBe(false);
        expect(isInterruptMarkerRow(userRow([null]))).toBe(false);
        expect(isInterruptMarkerRow(userRow([{ type: 'text' }]))).toBe(false);
        expect(isInterruptMarkerRow({})).toBe(false);
    });
});
