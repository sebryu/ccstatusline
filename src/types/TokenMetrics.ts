export interface TokenUsage {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
    };
}

export interface TranscriptLine {
    message?: { id?: string; usage?: TokenUsage; stop_reason?: string | null; model?: string };
    /** Identifies the API request a line belongs to. One request can emit several lines. */
    requestId?: string;
    isSidechain?: boolean;
    timestamp?: string;
    isApiErrorMessage?: boolean;
    type?: 'user' | 'assistant' | 'system' | 'progress' | 'file-history-snapshot';
}

/**
 * Tokens attributed to one model at one pricing tier.
 *
 * Cache writes are split by TTL because Anthropic prices them differently:
 * a 1h ephemeral write costs materially more than a 5m one, so collapsing
 * them into a single "cache creation" number skews the estimate.
 */
export interface TokenBucket {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreation5mTokens: number;
    cacheCreation1hTokens: number;
}

/**
 * Per-model tokens, split by whether the request's prompt crossed the
 * long-context threshold. Models billed at a premium above 200k tokens
 * (the [1m] context variants) need the two tiers priced separately.
 */
export interface ModelTokenBuckets {
    standard: TokenBucket;
    longContext: TokenBucket;
}

export type ModelTokenBucketMap = Record<string, ModelTokenBuckets>;

export interface TokenMetrics {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    // Hot (cache read) and cold (cache creation) split of cachedTokens.
    // Optional so existing TokenMetrics literals stay valid; getTokenMetrics always sets them.
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    totalTokens: number;
    contextLength: number;
    // Per-model token buckets used to estimate cost. Populated by getTokenMetrics
    // from the same pass that computes the totals above, so it costs no extra I/O.
    byModel?: ModelTokenBucketMap;
}
