import {
    describe,
    expect,
    it
} from 'vitest';

import { isLocalOnlyUserRow } from '../transcript-rows';

const userRow = (content: unknown, extra: object = {}) => ({ message: { role: 'user', content }, ...extra });

describe('isLocalOnlyUserRow', () => {
    it('matches the flags Claude Code sets on locally rendered rows', () => {
        expect(isLocalOnlyUserRow(userRow('anything', { isMeta: true }))).toBe(true);
        expect(isLocalOnlyUserRow(userRow('anything', { isCompactSummary: true }))).toBe(true);
        expect(isLocalOnlyUserRow(userRow('anything', { isVisibleInTranscriptOnly: true }))).toBe(true);
    });

    it('ignores flags that are present but not true', () => {
        expect(isLocalOnlyUserRow(userRow('hello', { isMeta: false }))).toBe(false);
        expect(isLocalOnlyUserRow(userRow('hello', { isCompactSummary: undefined }))).toBe(false);
    });

    it('matches the local-only tags at the start of string content', () => {
        expect(isLocalOnlyUserRow(userRow('<command-name>/clear</command-name>'))).toBe(true);
        expect(isLocalOnlyUserRow(userRow('<local-command-stdout>Set model to Opus</local-command-stdout>'))).toBe(true);
        expect(isLocalOnlyUserRow(userRow('<local-command-caveat>Caveat: tool results below</local-command-caveat>'))).toBe(true);
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

    it('treats a plain prompt and a row with no content as real', () => {
        expect(isLocalOnlyUserRow(userRow('run the tests'))).toBe(false);
        expect(isLocalOnlyUserRow(userRow(undefined))).toBe(false);
        expect(isLocalOnlyUserRow({})).toBe(false);
    });
});
