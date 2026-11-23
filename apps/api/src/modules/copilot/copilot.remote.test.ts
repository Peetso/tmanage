import { describe, expect, it, vi } from 'vitest';
import type { CopilotContext } from './copilot.provider.js';
import { LocalStubProvider } from './copilot.provider.js';
import {
  AnthropicCopilotProvider,
  OpenAiCopilotProvider,
  selectCopilotProvider,
} from './copilot.remote.provider.js';

/**
 * The paid-model path (Module 16, NS-13): coded but OFF unless the env selects it, every unsafe path
 * fails closed to the offline stub, only the caller's scope leaves the process, and no test touches
 * the network (fetch is always a mock).
 */

const ctx: CopilotContext = {
  principalKind: 'internal',
  role: 'member',
  hasOrgWideScope: false,
  reachableProjectCount: 2,
};
const env = (e: Record<string, string>): NodeJS.ProcessEnv => e;

/** A documented-shape Messages API body (Claude Haiku 5.5: thinking text omitted by default). */
const anthropicBody = (stopReason: string, content: unknown[]) => ({
  id: 'msg_01Remote',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 0 },
});
const THINKING = { type: 'thinking', thinking: '', signature: 'EqQBCkYIBxgCKkB' };
const ok = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200 });
const fetchOf = (fn: () => Promise<Response>) => vi.fn(fn) as unknown as typeof fetch;
const sent = (fetchImpl: ReturnType<typeof vi.fn>) => {
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string),
  };
};

describe('selectCopilotProvider', () => {
  it('defaults to the keyless offline stub and selects a named adapter only with key+model', () => {
    expect(selectCopilotProvider(env({})).id).toBe('local-stub');
    const base = { COPILOT_API_KEY: 'k', COPILOT_MODEL: 'claude-haiku-5-5' };
    expect(selectCopilotProvider(env({ ...base, COPILOT_PROVIDER: 'anthropic' })).id).toBe(
      'anthropic',
    );
    expect(selectCopilotProvider(env({ ...base, COPILOT_PROVIDER: 'openai' })).id).toBe('openai');
  });

  it('falls back to the stub (logging) when the key is missing or the name is unknown', () => {
    const log = vi.fn();
    expect(selectCopilotProvider(env({ COPILOT_PROVIDER: 'anthropic' }), { log }).id).toBe(
      'local-stub',
    );
    expect(
      selectCopilotProvider(
        env({ COPILOT_PROVIDER: 'x', COPILOT_API_KEY: 'k', COPILOT_MODEL: 'm' }),
        { log },
      ).id,
    ).toBe('local-stub');
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('AI-ROUTER-FIX: an Anthropic model outside the price table falls back to the stub', () => {
    const log = vi.fn();
    const chosen = selectCopilotProvider(
      env({ COPILOT_PROVIDER: 'anthropic', COPILOT_API_KEY: 'k', COPILOT_MODEL: 'claude-x' }),
      { log },
    );
    expect(chosen.id).toBe('local-stub');
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('remote adapters (request shaping carries only the caller scope)', () => {
  const deps = (fetchImpl: typeof fetch) => ({
    stub: new LocalStubProvider(),
    fetchImpl,
    log: vi.fn(),
    timeoutMs: 50,
  });

  it('shapes the Anthropic Messages request and returns model prose with stub scaffolding', async () => {
    const fetchImpl = vi.fn(async () =>
      ok(anthropicBody('end_turn', [THINKING, { type: 'text', text: 'hi there' }])),
    );
    const view = await new AnthropicCopilotProvider({
      apiKey: 'sk',
      model: 'claude-haiku-5-5',
      ...deps(fetchImpl as unknown as typeof fetch),
    }).ask('What is overdue?', ctx);
    const req = sent(fetchImpl);
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk');
    expect(req.headers['anthropic-version']).toBe('2026-10-21');
    expect(req.body.model).toBe('claude-haiku-5-5');
    // AI-ROUTER-FIX: thinking explicit (off), so the whole max_tokens is answer.
    expect(req.body.thinking).toEqual({ type: 'disabled' });
    expect(req.body.max_tokens).toBe(1_024);
    expect(req.body).not.toHaveProperty('temperature');
    expect(req.body.messages[0].content).toBe('What is overdue?');
    expect(JSON.stringify(req.body)).not.toContain('00000000'); // no project ids ever leave
    expect(view.answer).toBe('hi there');
    expect(view.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it('shapes the OpenAI Chat Completions request', async () => {
    const fetchImpl = vi.fn(async () => ok({ choices: [{ message: { content: 'ok' } }] }));
    const view = await new OpenAiCopilotProvider({
      apiKey: 'sk',
      model: 'gpt-x',
      ...deps(fetchImpl as unknown as typeof fetch),
    }).ask('hi', ctx);
    const req = sent(fetchImpl);
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.headers['authorization']).toBe('Bearer sk');
    expect(req.body.model).toBe('gpt-x');
    expect(req.body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(view.answer).toBe('ok');
  });

  it('fails closed to the stub answer and logs once on a non-2xx or thrown fetch', async () => {
    const log = vi.fn();
    const stub = new LocalStubProvider();
    const provider = new AnthropicCopilotProvider({
      apiKey: 'sk',
      model: 'claude-haiku-5-5',
      stub,
      fetchImpl: fetchOf(async () => new Response('x', { status: 500 })),
      log,
      timeoutMs: 50,
    });
    expect(await provider.ask('q', ctx)).toEqual(stub.ask('q', ctx));
    expect(await provider.ask('q', ctx)).toEqual(stub.ask('q', ctx));
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('AI-ROUTER-FIX: the Anthropic adapter never shows a cut or empty reply', () => {
  const run = async (body: unknown, model = 'claude-haiku-5-5') => {
    const log = vi.fn();
    const stub = new LocalStubProvider();
    const fetchImpl = vi.fn(async () => ok(body));
    const view = await new AnthropicCopilotProvider({
      apiKey: 'sk-ant-never-logged',
      model,
      stub,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log,
      timeoutMs: 50,
    }).ask('q', ctx);
    return { view, stubView: await stub.ask('q', ctx), log, sent: sent(fetchImpl) };
  };

  it('thinking only, stopped at max_tokens: the stub answer, logged with the shape only', async () => {
    const { view, stubView, log } = await run(anthropicBody('max_tokens', [THINKING]));
    expect(view).toEqual(stubView);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain('stop_reason=max_tokens blocks=[thinking]');
    expect(line).not.toContain('sk-ant');
  });

  it('text cut at max_tokens is not shown as a whole answer', async () => {
    const cut = anthropicBody('max_tokens', [{ type: 'text', text: 'Your overdue tasks are' }]);
    const { view, stubView } = await run(cut);
    expect(view).toEqual(stubView);
  });

  it('a refusal and a body of another shape fail closed too', async () => {
    expect((await run(anthropicBody('refusal', []))).view).toEqual(
      (await run(anthropicBody('refusal', []))).stubView,
    );
    const odd = await run({ content: [{ type: 'text', text: 'hi' }] });
    expect(odd.view).toEqual(odd.stubView);
  });

  it('Sonnet 5.5 is sent its own thinking-off form', async () => {
    const { sent: req, view } = await run(
      anthropicBody('end_turn', [{ type: 'text', text: 'ok' }]),
      'claude-sonnet-5-5',
    );
    expect(req.body.thinking).toEqual({ type: 'between_tools' });
    expect(view.answer).toBe('ok');
  });

  it('refuses to be built for a model outside the price table', () => {
    expect(
      () =>
        new AnthropicCopilotProvider({
          apiKey: 'sk',
          model: 'claude-x',
          stub: new LocalStubProvider(),
          fetchImpl: fetchOf(async () => ok({})),
          log: vi.fn(),
          timeoutMs: 50,
        }),
    ).toThrow(/price table/);
  });
});
