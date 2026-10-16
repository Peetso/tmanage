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
    const base = { COPILOT_API_KEY: 'k', COPILOT_MODEL: 'm' };
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
});

describe('remote adapters (request shaping carries only the caller scope)', () => {
  const deps = (fetchImpl: typeof fetch) => ({
    stub: new LocalStubProvider(),
    fetchImpl,
    log: vi.fn(),
    timeoutMs: 50,
  });

  it('shapes the Anthropic Messages request and returns model prose with stub scaffolding', async () => {
    const fetchImpl = vi.fn(async () => ok({ content: [{ type: 'text', text: 'hi there' }] }));
    const view = await new AnthropicCopilotProvider({
      apiKey: 'sk',
      model: 'claude-x',
      ...deps(fetchImpl as unknown as typeof fetch),
    }).ask('What is overdue?', ctx);
    const req = sent(fetchImpl);
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.body.model).toBe('claude-x');
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
      model: 'm',
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
