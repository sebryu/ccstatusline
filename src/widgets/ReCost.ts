import type { RenderContext } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import type { ModelTokenBucketMap } from '../types/TokenMetrics';
import type {
    CustomKeybind,
    Widget,
    WidgetEditorDisplay,
    WidgetItem
} from '../types/Widget';
import { mergeModelTokenBuckets } from '../utils/jsonl-metrics';
import { estimateCost } from '../utils/pricing';

import { makeModifierText } from './shared/editor-display';
import {
    isMetadataFlagEnabled,
    toggleMetadataFlag
} from './shared/metadata';
import { formatRawOrLabeledValue } from './shared/raw-or-labeled';

const ALWAYS_ESTIMATE_KEY = 'alwaysEstimate';
const EXCLUDE_SUBAGENTS_KEY = 'excludeSubagents';
const HIDE_WHEN_ZERO_KEY = 'hideWhenZero';

const TOGGLE_ALWAYS_ESTIMATE_ACTION = 'toggle-always-estimate';
const TOGGLE_EXCLUDE_SUBAGENTS_ACTION = 'toggle-exclude-subagents';
const TOGGLE_HIDE_WHEN_ZERO_ACTION = 'toggle-hide-when-zero';

/** Marks a value Claude Code did not report, so a reconstruction is never mistaken for billing truth. */
const ESTIMATE_PREFIX = '~';
/** Appended when some model's tokens had no pricing entry and were left out of the total. */
const INCOMPLETE_SUFFIX = '?';

export class ReCostWidget implements Widget {
    getDefaultColor(): string { return 'green'; }

    getDescription(): string {
        return 'Shows session cost, reconstructed from the transcript when Claude Code reports $0 (e.g. after resuming)';
    }

    getDisplayName(): string { return 'ReCost'; }
    getCategory(): string { return 'Session'; }

    getEditorDisplay(item: WidgetItem): WidgetEditorDisplay {
        const modifiers: string[] = [];
        if (isAlwaysEstimateEnabled(item)) {
            modifiers.push('always estimate');
        }
        if (areSubagentsExcluded(item)) {
            modifiers.push('no subagents');
        }
        if (isHideWhenZeroEnabled(item)) {
            modifiers.push('hide when zero');
        }

        return { displayText: this.getDisplayName(), modifierText: makeModifierText(modifiers) };
    }

    handleEditorAction(action: string, item: WidgetItem): WidgetItem | null {
        if (action === TOGGLE_ALWAYS_ESTIMATE_ACTION) {
            return toggleMetadataFlag(item, ALWAYS_ESTIMATE_KEY);
        }
        if (action === TOGGLE_EXCLUDE_SUBAGENTS_ACTION) {
            return toggleMetadataFlag(item, EXCLUDE_SUBAGENTS_KEY);
        }
        if (action === TOGGLE_HIDE_WHEN_ZERO_ACTION) {
            return toggleMetadataFlag(item, HIDE_WHEN_ZERO_KEY);
        }

        return null;
    }

    render(item: WidgetItem, context: RenderContext, settings: Settings): string | null {
        if (context.isPreview) {
            return formatRawOrLabeledValue(item, 'Cost: ', `${ESTIMATE_PREFIX}$2.45`);
        }

        const reportedCost = context.data?.cost?.total_cost_usd;
        const useReported = !isAlwaysEstimateEnabled(item)
            && reportedCost !== undefined
            && reportedCost > 0;

        if (useReported) {
            return formatRawOrLabeledValue(item, 'Cost: ', `$${reportedCost.toFixed(2)}`);
        }

        const byModel = collectModelBuckets(context, areSubagentsExcluded(item));
        if (!byModel) {
            return isHideWhenZeroEnabled(item) ? null : formatRawOrLabeledValue(item, 'Cost: ', 'n/a');
        }

        const { costUSD, unpricedModels } = estimateCost(byModel);
        if (costUSD === 0 && isHideWhenZeroEnabled(item)) {
            return null;
        }

        const marker = unpricedModels.length > 0 ? INCOMPLETE_SUFFIX : '';
        const formatted = `${ESTIMATE_PREFIX}$${costUSD.toFixed(2)}${marker}`;

        return formatRawOrLabeledValue(item, 'Cost: ', formatted);
    }

    getNumericValue(context: RenderContext, item: WidgetItem): number | null {
        const reportedCost = context.data?.cost?.total_cost_usd;
        if (!isAlwaysEstimateEnabled(item) && reportedCost !== undefined && reportedCost > 0) {
            return reportedCost;
        }

        const byModel = collectModelBuckets(context, areSubagentsExcluded(item));
        return byModel ? estimateCost(byModel).costUSD : null;
    }

    getCustomKeybinds(item?: WidgetItem): CustomKeybind[] {
        return [
            { key: 'a', label: '(a)lways estimate', action: TOGGLE_ALWAYS_ESTIMATE_ACTION },
            { key: 's', label: 'exclude (s)ubagents', action: TOGGLE_EXCLUDE_SUBAGENTS_ACTION },
            { key: 'h', label: '(h)ide when zero', action: TOGGLE_HIDE_WHEN_ZERO_ACTION }
        ];
    }

    supportsRawValue(): boolean { return true; }
    supportsColors(item: WidgetItem): boolean { return true; }
}

export function isAlwaysEstimateEnabled(item: WidgetItem): boolean {
    return isMetadataFlagEnabled(item, ALWAYS_ESTIMATE_KEY);
}

export function areSubagentsExcluded(item: WidgetItem): boolean {
    return isMetadataFlagEnabled(item, EXCLUDE_SUBAGENTS_KEY);
}

export function isHideWhenZeroEnabled(item: WidgetItem): boolean {
    return isMetadataFlagEnabled(item, HIDE_WHEN_ZERO_KEY);
}

/**
 * Merges the session's own per-model tokens with those of subagents that wrote
 * their own transcripts. Returns null when the transcript yielded no usable
 * usage data at all, which is what separates "nothing to price" from "$0.00".
 */
function collectModelBuckets(context: RenderContext, excludeSubagents: boolean): ModelTokenBucketMap | null {
    const sessionBuckets = context.tokenMetrics?.byModel;
    const subagentBuckets = excludeSubagents ? undefined : context.subagentModelBuckets ?? undefined;

    if (!sessionBuckets && !subagentBuckets) {
        return null;
    }

    const merged: ModelTokenBucketMap = {};
    if (sessionBuckets) {
        mergeModelTokenBuckets(merged, sessionBuckets);
    }
    if (subagentBuckets) {
        mergeModelTokenBuckets(merged, subagentBuckets);
    }

    return Object.keys(merged).length > 0 ? merged : null;
}
