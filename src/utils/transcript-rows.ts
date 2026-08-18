/** The shape of a transcript row this module needs; everything else is ignored. */
export interface LocalOnlyRowCandidate {
    isMeta?: boolean;
    isCompactSummary?: boolean;
    isVisibleInTranscriptOnly?: boolean;
    message?: { content?: unknown };
}

// Claude Code wraps its locally rendered user rows in these tags. The payload
// itself can hold ANSI escapes (command output is captured coloured), but the
// tag always opens the string, so a raw prefix test is correct and there is
// nothing to strip. Both slash-command orderings are listed: Claude Code used
// to lead with <command-name> and now leads with <command-message>, so matching
// only the former silently misses every newer echo.
const LOCAL_ONLY_TAGS = [
    '<command-name>',
    '<command-message>',
    '<local-command-stdout>',
    '<local-command-caveat>',
    '<bash-input>',
    '<bash-stdout>'
];

// The one locally rendered isMeta body that no tag already covers. isMeta on
// its own means "not typed by the human", which is NOT the same as "not sent to
// the server" — see isLocalOnlyUserRow.
const CONTEXT_USAGE_PREFIX = '## Context Usage';

// Written when the human stops a turn part-way. Always arrives as a single
// text block, never as a bare string.
const INTERRUPT_PREFIX = '[Request interrupted by user';

/**
 * Whether this `type: 'user'` row was written locally rather than sent to the
 * API: a slash-command echo, captured command or `!`-bash output, the context
 * report, or the summary a compaction leaves behind. All are recorded with role
 * 'user' but involve no request, so they refresh no prompt cache and must not
 * be read as an in-flight turn.
 *
 * `isMeta` deliberately does NOT qualify a row on its own. It marks a row the
 * human did not type, which includes plenty of rows that ARE sent: skill
 * invocations, autonomous-loop wakeups, hook-injected goals, cross-session
 * messages and pasted images all carry it and all get a real response. Treating
 * it as local would claim a stale cache during exactly the live work the
 * countdown exists to track, so it is only honoured for the one body above.
 *
 * The tag test matches only string content, and only as a prefix. Real tool
 * results arrive as a content *array* whose text can quote these tags verbatim,
 * and a genuine prompt can discuss one mid-sentence; treating either as local
 * would suppress a real in-flight turn.
 *
 * These flags and tags are undocumented Claude Code internals, so this is a
 * best-effort filter: if one is ever renamed the row simply stops matching and
 * the state reverts to reading it as a real turn — the behaviour before this
 * filter existed — rather than failing.
 */
export function isLocalOnlyUserRow(entry: LocalOnlyRowCandidate): boolean {
    if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) {
        return true;
    }
    const content = entry.message?.content;
    if (typeof content !== 'string') {
        return false;
    }
    const text = content.trimStart();
    if (entry.isMeta === true && text.startsWith(CONTEXT_USAGE_PREFIX)) {
        return true;
    }
    for (const tag of LOCAL_ONLY_TAGS) {
        if (text.startsWith(tag)) {
            return true;
        }
    }
    return false;
}

/**
 * Whether this row is the marker Claude Code writes when the human interrupts a
 * turn. Unlike a local-only row this is not transparent: it means the turn
 * ended. The row it interrupted — usually the pending `tool_result` — sits
 * directly above it, so a scan that merely skipped the marker would find that
 * row and report an in-flight turn that no longer exists.
 *
 * This is the one shape that must be read out of an array, so it is matched
 * narrowly: the first block only, `type: 'text'` only, prefix only. A
 * `tool_result` block never qualifies.
 */
export function isInterruptMarkerRow(entry: LocalOnlyRowCandidate): boolean {
    const content = entry.message?.content;
    if (!Array.isArray(content)) {
        return false;
    }
    const first: unknown = content[0];
    if (typeof first !== 'object' || first === null) {
        return false;
    }
    const block = first as { type?: unknown; text?: unknown };
    return block.type === 'text' && typeof block.text === 'string' && block.text.startsWith(INTERRUPT_PREFIX);
}
