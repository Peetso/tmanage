import type { AiUsage } from './ai-cost.js';

/**
 * Reads a Claude Messages API response body (plan 62, slice 62-02, B07) into exact types. Anything
 * that does not have the documented shape is rejected as malformed, never guessed: the caller then
 * treats the call as failed (and, once sent, settles it in full — 62-06).
 */

/** Why the model stopped. Any other value is a malformed response. */
export type AiStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'model_context_window_exceeded';

const STOP_REASONS: ReadonlySet<string> = new Set<AiStopReason>([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
  'model_context_window_exceeded',
]);

export type JsonObject = { readonly [key: string]: unknown };

/** The blocks the orchestrator reads. Thinking blocks are kept only in {@link AiReplay}. */
export type AiResponseBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: JsonObject;
    };

/**
 * The assistant content exactly as returned, thinking blocks included, to be sent back unchanged
 * on the next turn (preserved thinking). Branded so only a parsed response can produce it.
 */
export type AiReplay = readonly JsonObject[] & { readonly __aiReplay: true };

export interface AiResponse {
  readonly id: string;
  readonly model: string;
  readonly stopReason: AiStopReason;
  readonly content: readonly AiResponseBlock[];
  readonly replay: AiReplay;
  readonly usage: AiUsage;
}

/** The body was not a Messages API response. */
export class AiMalformedResponseError extends Error {
  override readonly name = 'AiMalformedResponseError';
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AiMalformedResponseError(`usage.${field} is not a token count`);
  }
  return value;
}

/**
 * The usage buckets. Cache writes are split by TTL from `usage.cache_creation`; any written tokens
 * the breakdown does not attribute are counted at the dearer 1-hour rate, so the pool is never
 * under-charged.
 */
export function readUsage(raw: unknown): AiUsage {
  if (!isObject(raw)) throw new AiMalformedResponseError('usage is missing');
  if (raw['input_tokens'] === undefined || raw['output_tokens'] === undefined) {
    throw new AiMalformedResponseError('usage lacks input_tokens or output_tokens');
  }
  const written = count(raw['cache_creation_input_tokens'], 'cache_creation_input_tokens');
  const split = isObject(raw['cache_creation']) ? raw['cache_creation'] : {};
  const fiveMinutes = count(split['ephemeral_5m_input_tokens'], 'ephemeral_5m_input_tokens');
  const oneHour = count(split['ephemeral_1h_input_tokens'], 'ephemeral_1h_input_tokens');
  const attributed5m = Math.min(fiveMinutes, written);
  return {
    inputTokens: count(raw['input_tokens'], 'input_tokens'),
    cacheWrite5mTokens: attributed5m,
    cacheWrite1hTokens: Math.max(oneHour, written - attributed5m),
    cacheReadTokens: count(raw['cache_read_input_tokens'], 'cache_read_input_tokens'),
    outputTokens: count(raw['output_tokens'], 'output_tokens'),
  };
}

function readBlock(raw: JsonObject): AiResponseBlock | undefined {
  if (raw['type'] === 'text') {
    if (typeof raw['text'] !== 'string')
      throw new AiMalformedResponseError('text block lacks text');
    return { type: 'text', text: raw['text'] };
  }
  if (raw['type'] === 'tool_use') {
    const { id, name, input } = raw;
    if (typeof id !== 'string' || typeof name !== 'string' || !isObject(input)) {
      throw new AiMalformedResponseError('tool_use block lacks id, name or input');
    }
    return { type: 'tool_use', id, name, input };
  }
  if (raw['type'] === 'thinking' || raw['type'] === 'redacted_thinking') return undefined;
  throw new AiMalformedResponseError(`unexpected content block type ${String(raw['type'])}`);
}

/** The response of one Messages API call, or {@link AiMalformedResponseError}. */
export function readResponse(body: unknown): AiResponse {
  if (!isObject(body) || body['type'] !== 'message') {
    throw new AiMalformedResponseError('body is not a message');
  }
  const { id, model, stop_reason: stopReason, content } = body;
  if (typeof id !== 'string' || typeof model !== 'string') {
    throw new AiMalformedResponseError('message lacks id or model');
  }
  if (typeof stopReason !== 'string' || !STOP_REASONS.has(stopReason)) {
    throw new AiMalformedResponseError('message has no known stop_reason');
  }
  if (!Array.isArray(content) || !content.every(isObject)) {
    throw new AiMalformedResponseError('message content is not a list of blocks');
  }
  const blocks = content as readonly JsonObject[];
  return {
    id,
    model,
    stopReason: stopReason as AiStopReason,
    content: blocks.flatMap((block) => readBlock(block) ?? []),
    replay: blocks as AiReplay,
    usage: readUsage(body['usage']),
  };
}
