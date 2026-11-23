import { ANTHROPIC_API_VERSION, THINKING_OFF } from './ai-client.js';
import { isPricedModel, type AiModelId } from './ai-price-table.js';
import { AiMalformedResponseError, readResponse } from './ai-response.js';
import { LocalStubProvider } from './copilot.provider.js';
import type { CopilotContext, CopilotProvider, CopilotProviderAnswer } from './copilot.provider.js';

/**
 * The paid-model path of the AI copilot — CODED, but OFF by default (Module 16, NS-13 /
 * Needs-Peter).
 *
 * `copilot.provider.ts` defines the provider seam and the deterministic, offline
 * {@link LocalStubProvider} that is the only provider wired on by default. This file adds two real
 * adapters behind that same seam — one for the Anthropic Messages API, one for the OpenAI Chat
 * Completions API — reached with plain `fetch` and **no new SDK dependency**. They are selected by
 * environment only ({@link selectCopilotProvider}); with nothing configured the stub is returned, so
 * the default build makes no network call and needs no key.
 *
 * ## Three invariants, so turning the flag on can never make the copilot less safe than the stub
 *
 *   1. **Fail closed to the stub.** A missing key, an unknown provider name, a non-2xx response, a
 *      timeout, a malformed body, or an empty completion all fall back to the offline stub's answer.
 *      The call is wrapped so a provider failure is logged **once** per adapter and never throws:
 *      `copilot.service` keeps returning a well-formed answer view.
 *   2. **Only the caller's own reach leaves the process.** The request carries the question and a
 *      scope *description* derived from {@link CopilotContext} (role, principal kind, project
 *      *count*) — never a project id, a record, or another tenant's data. The service resolves the
 *      flag and the `search.use` capability before a provider is ever asked, so an adapter cannot
 *      widen access; it only ever sees what the asking member could already read.
 *   3. **The answer-view contract is preserved.** The model supplies the prose `answer`; the
 *      evidence and the next safe (read-only) action come from the stub's scaffolding, which cites
 *      in-app routes the member can actually open, so a model can neither invent a link nor propose a
 *      write.
 */

/** How a remote adapter reaches its model and what it falls back to. Injected so tests mock fetch. */
export interface RemoteProviderDeps {
  readonly apiKey: string;
  readonly model: string;
  /** The stub used for evidence/next-action scaffolding and as the fail-closed fallback answer. */
  readonly stub: CopilotProvider;
  /** `globalThis.fetch` in production; a mock in tests. No network is ever touched in a test. */
  readonly fetchImpl: typeof fetch;
  /** One-line warning sink. Defaults to `console.warn`; injected so a test can assert "log once". */
  readonly log: (message: string) => void;
  /** Abort budget for the single request. */
  readonly timeoutMs: number;
}

/** The shape every adapter turns a question into: the endpoint and the fetch init (minus signal). */
interface RemoteRequest {
  readonly url: string;
  readonly init: RequestInit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The only member-derived text that leaves the process: a scope *description*, never an id or a
 * record. It tells the model the boundary the service has already enforced so the prose answer stays
 * inside it, and that the copilot is read-only.
 */
function systemPrompt(context: CopilotContext): string {
  const scope = context.hasOrgWideScope
    ? 'records across this one organization that the caller’s role already permits'
    : `the ${context.reachableProjectCount} project(s) the caller is a member of`;
  return (
    'You are TManage’s read-only assistant. Answer only from ' +
    `${scope}. You must never reveal anything outside the caller’s existing permissions, never ` +
    'name another organization’s data, and never perform or propose a change — only read-only ' +
    'guidance. If you are unsure, say so and point the caller at global search.'
  );
}

/** Shared adapter: shape a request, call fetch under a timeout, and fail closed to the stub. */
abstract class RemoteCopilotProvider implements CopilotProvider {
  abstract readonly id: string;
  private warned = false;

  constructor(protected readonly deps: RemoteProviderDeps) {}

  async ask(question: string, context: CopilotContext): Promise<CopilotProviderAnswer> {
    // Built first: it is both the fail-closed answer and the source of the evidence/next-action
    // scaffolding the answer view requires, so a model only ever supplies the prose.
    const fallback = await this.deps.stub.ask(question, context);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    try {
      const { url, init } = this.buildRequest(question, context);
      const response = await this.deps.fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        return this.failClosed(fallback, `${this.id} responded ${response.status}`);
      }
      const answer = this.extractAnswer(await response.json()).trim();
      if (answer.length === 0) {
        return this.failClosed(fallback, `${this.id} returned an empty completion`);
      }
      return { answer, evidence: fallback.evidence, nextSafeAction: fallback.nextSafeAction };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.failClosed(fallback, `${this.id} request failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private failClosed(fallback: CopilotProviderAnswer, reason: string): CopilotProviderAnswer {
    if (!this.warned) {
      this.warned = true;
      this.deps.log(`[copilot] ${reason}; falling back to the offline local stub.`);
    }
    return fallback;
  }

  protected abstract buildRequest(question: string, context: CopilotContext): RemoteRequest;
  protected abstract extractAnswer(body: unknown): string;
}

/**
 * The remote copilot's answer budget. AI-ROUTER-FIX: with thinking off (below) all of it is answer;
 * the current models think by default and count thinking toward `max_tokens`, which could leave a
 * reply with no text at all.
 */
export const REMOTE_COPILOT_MAX_TOKENS = 1_024;

/**
 * Anthropic Messages API (`POST /v1/messages`).
 *
 * AI-ROUTER-FIX: the same request rules as the in-app AI client (`ai-client.ts`): the current API
 * version, thinking stated explicitly in the model's own "off" form (Haiku 5.5 `disabled`, Sonnet
 * 5.5 `between_tools`), effort `low`, and the reply read by the strict Messages parser. So the
 * model must be one of the priced models ({@link selectCopilotProvider} refuses any other); a reply
 * that is not a clean `end_turn` with text (cut at `max_tokens`, refused, thinking only) is a
 * clear stop that fails closed to the stub, logged with its stop reason and block types only.
 */
export class AnthropicCopilotProvider extends RemoteCopilotProvider {
  readonly id = 'anthropic';

  /** The priced model this adapter calls; refused at construction otherwise. */
  private readonly pricedModel: AiModelId;

  constructor(deps: RemoteProviderDeps) {
    super(deps);
    if (!isPricedModel(deps.model)) {
      throw new Error('the Anthropic copilot adapter needs a model from the price table');
    }
    this.pricedModel = deps.model;
  }

  protected override buildRequest(question: string, context: CopilotContext): RemoteRequest {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.deps.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify({
          model: this.pricedModel,
          max_tokens: REMOTE_COPILOT_MAX_TOKENS,
          thinking: THINKING_OFF[this.pricedModel],
          output_config: { effort: 'low' },
          system: systemPrompt(context),
          messages: [{ role: 'user', content: question }],
        }),
      },
    };
  }

  protected override extractAnswer(body: unknown): string {
    let response;
    try {
      response = readResponse(body);
    } catch (error: unknown) {
      const reason = error instanceof AiMalformedResponseError ? error.message : 'unreadable';
      throw new Error(`malformed reply (${reason})`);
    }
    const text = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('');
    if (response.stopReason !== 'end_turn' || text.trim().length === 0) {
      // A clear stop, never a cut or empty answer shown as if whole. Shape only in the reason.
      const blocks = response.replay
        .map((block) => (typeof block['type'] === 'string' ? block['type'] : 'unknown'))
        .join(',');
      throw new Error(`no whole answer (stop_reason=${response.stopReason} blocks=[${blocks}])`);
    }
    return text;
  }
}

/** OpenAI Chat Completions API (`POST /v1/chat/completions`). */
export class OpenAiCopilotProvider extends RemoteCopilotProvider {
  readonly id = 'openai';

  protected override buildRequest(question: string, context: CopilotContext): RemoteRequest {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.deps.apiKey}`,
        },
        body: JSON.stringify({
          model: this.deps.model,
          messages: [
            { role: 'system', content: systemPrompt(context) },
            { role: 'user', content: question },
          ],
        }),
      },
    };
  }

  protected override extractAnswer(body: unknown): string {
    if (isRecord(body) && Array.isArray(body['choices'])) {
      const first: unknown = body['choices'][0];
      if (
        isRecord(first) &&
        isRecord(first['message']) &&
        typeof first['message']['content'] === 'string'
      ) {
        return first['message']['content'];
      }
    }
    return '';
  }
}

const PRICED_MODELS_TEXT = Object.keys(THINKING_OFF).join(', ');

/** Overridable collaborators for {@link selectCopilotProvider}; defaults are the real ones. */
export interface SelectProviderDeps {
  readonly fetchImpl?: typeof fetch;
  readonly log?: (message: string) => void;
  readonly timeoutMs?: number;
}

/**
 * Choose the copilot provider from the environment. `COPILOT_PROVIDER` is `stub` (the default),
 * `anthropic`, or `openai`; a real adapter also needs `COPILOT_API_KEY` and `COPILOT_MODEL`.
 *
 * Every path that cannot produce a safe real adapter — provider unset or `stub`, a key or model
 * missing, no `fetch` available, or an unrecognised name — returns the offline {@link
 * LocalStubProvider}, logging once why. The default environment (nothing set) therefore yields the
 * stub, so the shipped build is offline and keyless exactly as Peter requires.
 */
export function selectCopilotProvider(
  env: NodeJS.ProcessEnv = process.env,
  deps: SelectProviderDeps = {},
): CopilotProvider {
  const stub = new LocalStubProvider();
  const choice = (env['COPILOT_PROVIDER'] ?? 'stub').trim().toLowerCase();
  const log = deps.log ?? ((message: string) => console.warn(message));

  if (choice === '' || choice === 'stub') {
    return stub;
  }

  const apiKey = env['COPILOT_API_KEY']?.trim();
  const model = env['COPILOT_MODEL']?.trim();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  if (!apiKey || !model) {
    log(
      `[copilot] COPILOT_PROVIDER=${choice} but COPILOT_API_KEY and/or COPILOT_MODEL are unset; ` +
        'using the offline local stub.',
    );
    return stub;
  }
  if (typeof fetchImpl !== 'function') {
    log(
      `[copilot] COPILOT_PROVIDER=${choice} but no fetch is available; using the offline local stub.`,
    );
    return stub;
  }

  const remoteDeps: RemoteProviderDeps = {
    apiKey,
    model,
    stub,
    fetchImpl,
    log,
    timeoutMs: deps.timeoutMs ?? 10_000,
  };
  if (choice === 'anthropic') {
    if (!isPricedModel(model)) {
      log(
        `[copilot] COPILOT_MODEL is not a model of the price table (${PRICED_MODELS_TEXT}); ` +
          'using the offline local stub.',
      );
      return stub;
    }
    return new AnthropicCopilotProvider(remoteDeps);
  }
  if (choice === 'openai') {
    return new OpenAiCopilotProvider(remoteDeps);
  }

  log(`[copilot] unknown COPILOT_PROVIDER="${choice}"; using the offline local stub.`);
  return stub;
}
