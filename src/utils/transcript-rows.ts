/** The shape of a transcript row this module needs; everything else is ignored. */
export interface LocalOnlyRowCandidate {
    isMeta?: boolean;
    isCompactSummary?: boolean;
    isVisibleInTranscriptOnly?: boolean;
    message?: { content?: unknown };
}

// Claude Code wraps its locally rendered user rows in these tags. The payload
// itself can hold ANSI escapes (command stdout is captured coloured), but the
// tag always opens the string, so a raw prefix test is correct and there is
// nothing to strip.
const LOCAL_ONLY_TAGS = ['<command-name>', '<local-command-stdout>', '<local-command-caveat>'];

/**
 * Whether this `type: 'user'` row was written locally rather than sent to the
 * API: a slash-command echo, captured command output, a hook injection, or the
 * summary a compaction leaves behind. All are recorded with role 'user' but
 * involve no request, so they refresh no prompt cache and must not be read as
 * an in-flight turn.
 *
 * The tag test deliberately matches only string content, and only as a prefix.
 * Real tool results arrive as a content *array* whose text can quote these tags
 * verbatim (a transcript that talks about them), and treating one of those as
 * local would suppress a genuine in-flight turn.
 *
 * These flags and tags are undocumented Claude Code internals, so this is a
 * best-effort filter: if one is ever renamed the row simply stops matching and
 * the state reverts to reading it as a real turn — the behaviour before this
 * filter existed — rather than failing.
 */
export function isLocalOnlyUserRow(entry: LocalOnlyRowCandidate): boolean {
    if (entry.isMeta === true || entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) {
        return true;
    }
    const content = entry.message?.content;
    if (typeof content !== 'string') {
        return false;
    }
    const text = content.trimStart();
    for (const tag of LOCAL_ONLY_TAGS) {
        if (text.startsWith(tag)) {
            return true;
        }
    }
    return false;
}
