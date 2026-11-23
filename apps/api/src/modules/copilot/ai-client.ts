import { costOfCall, type AiCost } from './ai-cost.js';
import { isPricedModel, type AiModelId } from './ai-price-table.js';
import {
  AiMalformedResponseError,
  readResponse,
  type AiReplay,
  type AiResponse,
  type JsonObject,
} from './ai-response.js';

/**
 * The Claude tool-use client of the in-app AI (plan 62, slice 62-02, B07): one Messages API call
 * with tools under strict schemas, cache breakpoints, a timeout and the usage read into a cost.
 *
 * Not wired anywhere yet: no route, module or provider imports it (the orchestrator, 62-09, will,
 * behind the existing provider switch and the budget hold of 62-06). Without a key it cannot be
 * built at all.
 *
 * Key hygiene: the key lives only in this module's closure and in the one request header. It is
 * never a property of the client, never in an error message, and this file logs nothing.
 *
 * Raw `fetch`, no SDK: the same choice as `copilot.remote.provider.ts` (no new dependency on a
 * shared-hosting build), and it makes the exact request shape testable with a mocked fetch.
 */

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
/** The Messages API version every Anthropic call of the app sends (the remote copilot too). */
export const ANTHROPIC_API_VERSION = '2026-10-21';
const API_VERSION = ANTHROPIC_API_VERSION;
/** The API's limit on `cache_control` breakpoints in one request. */
const MAX_CACHE_BREAKPOINTS = 4;

export type AiCacheTtl = '5m' | '1h';
/**
 * Thinking off (`disabled` / `between_tools`) is accepted only at effort `high` or below, so this
 * type stops at `high` on purpose: `xhigh` and `max` would turn a thinking-off request into a 400.
 */
export type AiEffort = 'low' | 'medium' | 'high';

/**
 * AI-ROUTER-FIX: whether the model thinks before it answers, said explicitly on every request.
 * Claude Haiku 5.5 and Sonnet 5.5 think by default (adaptive) and thinking counts toward
 * `max_tokens`, so with thinking on a reply can end at `max_tokens` with no visible answer.
 * `off` gives the whole `max_tokens` to the answer; the client writes the model's own form of it
 * ({@link THINKING_OFF}), so a model swap can never send a form the model rejects.
 */
export type AiThinking = 'off' | 'adaptive';

/**
 * The wire form of "thinking off" for each priced model (Anthropic, current model docs):
 * Claude Haiku 5.5 accepts `{type: "disabled"}` at effort `high` or below; Claude Sonnet 5.5
 * rejects `disabled` (400) and turns thinking off with `{type: "between_tools"}` (no other field;
 * its short notes between tool calls come back as `thinking` blocks and are replayed unchanged).
 * A `Record` over the price table: a newly priced model does not compile until it says.
 */
export const THINKING_OFF: Readonly<Record<AiModelId, JsonObject>> = Object.freeze({
  'claude-haiku-5-5': { type: 'disabled' },
  'claude-sonnet-5-5': { type: 'between_tools' },
});

/**
 * A strict tool input schema: an object schema that names every required field and allows no other
 * (`additionalProperties: false`), at every nested object level.
 */
export interface AiStrictSchema extends JsonObject {
  readonly type: 'object';
  readonly properties: JsonObject;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface AiToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: AiStrictSchema;
  /** A breakpoint after this tool (put it on the last tool of a cached prefix). */
  readonly cache?: AiCacheTtl;
}

export interface AiSystemBlock {
  readonly text: string;
  readonly cache?: AiCacheTtl;
}

export type AiUserBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_result';
      readonly toolUseId: string;
      readonly content: string;
      readonly isError?: boolean;
    }
  | AiDocumentBlock;

/**
 * 62-25: a PDF the model reads as pages (text and images), sent as a base64 `document` block
 * before the question. Only the chat's explicit "read the scan with AI" turn builds one.
 * `pages` is ours (the prompt estimate), never sent.
 */
export interface AiDocumentBlock {
  readonly type: 'document';
  readonly mediaType: 'application/pdf';
  /** The file's bytes, base64. */
  readonly data: string;
  readonly pages: number;
}

export type AiMessage =
  | { readonly role: 'user'; readonly content: string | readonly AiUserBlock[] }
  | { readonly role: 'assistant'; readonly content: AiReplay };

/**
 * How the model may use the tools. `auto` (the default) lets it answer in text; `tool` forces
 * exactly one call of the named tool (sent with `disable_parallel_tool_use`). Forcing is accepted
 * only by the models in {@link FORCED_TOOL_CHOICE_MODELS}: Claude Opus 5.5, Sonnet 5.5 and the
 * Fable 5.1+ models answer a forced `tool_choice` with a 400, so the client refuses it before it
 * is sent rather than let a model swap turn into a provider error.
 */
export type AiToolChoice =
  { readonly type: 'auto' } | { readonly type: 'tool'; readonly name: string };

/**
 * The priced models that accept a forced `tool_choice`. Claude Haiku 5.5 does, and a forced call
 * skips its (default-on) adaptive thinking, so a short structured answer cannot be eaten by
 * thinking tokens. Claude Sonnet 5.5 rejects it (400).
 */
export const FORCED_TOOL_CHOICE_MODELS: ReadonlySet<AiModelId> = new Set<AiModelId>([
  'claude-haiku-5-5',
]);

export interface AiRequest {
  readonly model: AiModelId;
  readonly maxTokens: number;
  readonly effort: AiEffort;
  /** Required: no request leaves thinking to the model's default. */
  readonly thinking: AiThinking;
  readonly system: readonly AiSystemBlock[];
  readonly tools: readonly AiToolDefinition[];
  readonly messages: readonly AiMessage[];
  /** Absent = `auto`. */
  readonly toolChoice?: AiToolChoice;
  /** Automatic breakpoint on the last cacheable block of the conversation. */
  readonly cacheConversation?: AiCacheTtl;
}

export interface AiCallResult extends AiResponse {
  readonly cost: AiCost;
  readonly latencyMs: number;
}

export type AiClientErrorKind =
  'invalid_request' | 'unpriced_model' | 'http' | 'timeout' | 'network' | 'malformed';

/**
 * A call that produced no usable response. `sent` says whether the request may have reached the
 * provider (the budget then settles it in full); `retryable` marks 408/409/429/5xx and network
 * failures. The message names the cause only: never the key, a header or the request body.
 */
export class AiClientError extends Error {
  override readonly name = 'AiClientError';

  constructor(
    readonly kind: AiClientErrorKind,
    message: string,
    readonly sent: boolean,
    readonly retryable: boolean = false,
    readonly status?: number,
    /**
     * The provider's own error text for a 400 (which field it rejected), one line, at most 300
     * characters. For the server log only: never shown to a member.
     */
    readonly detail?: string,
  ) {
    super(message);
  }
}

export interface AiClientDeps {
  readonly apiKey: string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly now?: () => number;
}

export interface AiClient {
  call(request: AiRequest): Promise<AiCallResult>;
}

const cacheControl = (ttl: AiCacheTtl): JsonObject =>
  ttl === '5m' ? { type: 'ephemeral' } : { type: 'ephemeral', ttl: '1h' };

function invalid(message: string): AiClientError {
  return new AiClientError('invalid_request', message, false);
}

/** Every object level of a schema is strict, or the request is refused before it is sent. */
function assertStrict(schema: unknown, path: string): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return;
  const node = schema as JsonObject;
  if (node['type'] === 'object') {
    const properties = node['properties'];
    const required = node['required'];
    if (
      node['additionalProperties'] !== false ||
      typeof properties !== 'object' ||
      properties === null ||
      !Array.isArray(required)
    ) {
      throw invalid(`tool schema ${path} is not strict`);
    }
    for (const [key, child] of Object.entries(properties)) assertStrict(child, `${path}.${key}`);
  }
  if (node['items'] !== undefined) assertStrict(node['items'], `${path}[]`);
}

function validate(request: AiRequest): void {
  if (!isPricedModel(request.model)) {
    throw new AiClientError('unpriced_model', 'model is not in the price table', false);
  }
  if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1) {
    throw invalid('maxTokens must be a positive whole number');
  }
  if (request.messages.length === 0 || request.messages[0]?.role !== 'user') {
    throw invalid('the conversation must start with a user message');
  }
  const names = new Set<string>();
  for (const tool of request.tools) {
    if (names.has(tool.name)) throw invalid(`tool ${tool.name} is defined twice`);
    names.add(tool.name);
    assertStrict(tool.inputSchema, tool.name);
  }
  const choice = request.toolChoice;
  if (choice?.type === 'tool') {
    if (!names.has(choice.name)) throw invalid(`forced tool ${choice.name} is not defined`);
    if (!FORCED_TOOL_CHOICE_MODELS.has(request.model)) {
      throw invalid(`model ${request.model} does not accept a forced tool choice`);
    }
  }
  const breakpoints =
    request.system.filter((block) => block.cache !== undefined).length +
    request.tools.filter((tool) => tool.cache !== undefined).length +
    (request.cacheConversation === undefined ? 0 : 1);
  if (breakpoints > MAX_CACHE_BREAKPOINTS) {
    throw invalid(`at most ${MAX_CACHE_BREAKPOINTS} cache breakpoints per request`);
  }
}

function userBlock(block: AiUserBlock): JsonObject {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'document') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: block.mediaType, data: block.data },
    };
  }
  return {
    type: 'tool_result',
    tool_use_id: block.toolUseId,
    content: block.content,
    ...(block.isError === true ? { is_error: true } : {}),
  };
}

function toolChoiceBody(choice: AiToolChoice | undefined): JsonObject {
  if (choice === undefined || choice.type === 'auto') return { type: 'auto' };
  return { type: 'tool', name: choice.name, disable_parallel_tool_use: true };
}

/** The Messages API body. Tools come first and system second, so both sit in the cached prefix. */
export function messagesBody(request: AiRequest): JsonObject {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    thinking: request.thinking === 'off' ? THINKING_OFF[request.model] : { type: 'adaptive' },
    output_config: { effort: request.effort },
    ...(request.tools.length === 0
      ? {}
      : {
          tool_choice: toolChoiceBody(request.toolChoice),
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
            strict: true,
            ...(tool.cache === undefined ? {} : { cache_control: cacheControl(tool.cache) }),
          })),
        }),
    system: request.system.map((block) => ({
      type: 'text',
      text: block.text,
      ...(block.cache === undefined ? {} : { cache_control: cacheControl(block.cache) }),
    })),
    messages: request.messages.map((message) =>
      message.role === 'assistant'
        ? { role: 'assistant', content: message.content }
        : {
            role: 'user',
            content:
              typeof message.content === 'string'
                ? message.content
                : message.content.map(userBlock),
          },
    ),
    ...(request.cacheConversation === undefined
      ? {}
      : { cache_control: cacheControl(request.cacheConversation) }),
  };
}

const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const MAX_ERROR_DETAIL = 300;

/**
 * The API's error type (for example `rate_limit_error`) and, for a 400, its message: the
 * provider's description of which request field it rejected. The message goes to the server log
 * only (through {@link AiClientError.detail}), cut to one line of at most 300 characters.
 */
async function errorInfo(
  response: Response,
): Promise<{ readonly type: string; readonly detail?: string }> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const error = (body as JsonObject)['error'];
      if (typeof error === 'object' && error !== null) {
        const type = (error as JsonObject)['type'];
        const message = (error as JsonObject)['message'];
        const safeType = typeof type === 'string' && /^[a-z_]{1,64}$/.test(type) ? type : null;
        if (safeType !== null) {
          if (response.status !== 400 || typeof message !== 'string') return { type: safeType };
          const detail = message.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_DETAIL);
          return { type: safeType, detail };
        }
      }
    }
  } catch {
    // An unreadable error body says nothing more than its status.
  }
  return { type: 'unknown_error' };
}

/** A client bound to one key. Refuses to exist without a key or a positive timeout. */
export function createAiClient(deps: AiClientDeps): AiClient {
  const apiKey = deps.apiKey.trim();
  if (apiKey.length === 0) throw invalid('an AI client needs a key');
  if (!Number.isSafeInteger(deps.timeoutMs) || deps.timeoutMs < 1) {
    throw invalid('timeoutMs must be a positive whole number');
  }
  const { fetchImpl, timeoutMs } = deps;
  const now = deps.now ?? Date.now;

  const timedOut = (): AiClientError =>
    new AiClientError('timeout', `no response within ${timeoutMs} ms`, true, true);

  async function send(request: AiRequest, signal: AbortSignal): Promise<Response> {
    try {
      return await fetchImpl(MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(messagesBody(request)),
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted) throw timedOut();
      const name = error instanceof Error ? error.name : 'unknown';
      throw new AiClientError('network', `request failed (${name})`, true, true);
    }
  }

  async function read(request: AiRequest, signal: AbortSignal): Promise<AiResponse> {
    const response = await send(request, signal);
    if (!response.ok) {
      const { type, detail } = await errorInfo(response);
      throw new AiClientError(
        'http',
        `provider responded ${response.status} (${type})`,
        true,
        RETRYABLE_STATUS.has(response.status),
        response.status,
        detail,
      );
    }
    try {
      return readResponse(await response.json());
    } catch (error: unknown) {
      if (signal.aborted) throw timedOut();
      const reason = error instanceof AiMalformedResponseError ? error.message : 'not JSON';
      throw new AiClientError('malformed', `malformed response: ${reason}`, true);
    }
  }

  return {
    async call(request: AiRequest): Promise<AiCallResult> {
      validate(request);
      const started = now();
      // One budget for the whole call: connecting, the headers and reading the body.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const parsed = await read(request, controller.signal);
        return {
          ...parsed,
          cost: costOfCall(request.model, parsed.usage),
          latencyMs: Math.max(0, now() - started),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
