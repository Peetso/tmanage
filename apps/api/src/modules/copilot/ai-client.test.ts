import { describe, expect, it, vi } from 'vitest';
import {
  AiClientError,
  createAiClient,
  type AiClient,
  type AiRequest,
  type AiStrictSchema,
} from './ai-client.js';
import { AI_PRICE_TABLE_VERSION } from './ai-price-table.js';
import type { AiReplay } from './ai-response.js';

/**
 * Plan 62, slice 62-02 (B07): the Claude tool-use client. Fetch is always a mock; no test touches
 * the network. The key is a sentinel that must never appear outside the one request header.
 */

const SENTINEL_KEY = 'sk-ant-SENTINEL-7f3a9c-never-print';

const strict = (properties: AiStrictSchema['properties'], required: string[]): AiStrictSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const TASK_SCHEMA = strict(
  {
    title: { type: 'string' },
    assignee: strict({ id: { type: 'string' } }, ['id']),
    tags: { type: 'array', items: { type: 'string' } },
  },
  ['title', 'assignee', 'tags'],
);

const message = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'message',
  id: 'msg_1',
  model: 'claude-haiku-5-5',
  role: 'assistant',
  stop_reason: 'tool_use',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig-1' },
    { type: 'text', text: 'Creating the task.' },
    { type: 'tool_use', id: 'toolu_1', name: 'create_task', input: { title: 'Brief' } },
  ],
  usage: {
    input_tokens: 1_000,
    output_tokens: 500,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  ...overrides,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const request = (overrides: Partial<AiRequest> = {}): AiRequest => ({
  model: 'claude-haiku-5-5',
  maxTokens: 2_048,
  effort: 'low',
  system: [{ text: 'You are the TManage assistant.', cache: '1h' }],
  tools: [
    { name: 'list_tasks', description: 'List tasks', inputSchema: strict({}, []) },
    { name: 'create_task', description: 'Create a task', inputSchema: TASK_SCHEMA, cache: '5m' },
  ],
  messages: [{ role: 'user', content: 'Add a task "Brief"' }],
  ...overrides,
});

function clientWith(fetchImpl: (url: string, init: RequestInit) => Promise<Response>): {
  client: AiClient;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const fetchMock = vi.fn(fetchImpl);
  let clock = 1_000;
  const client = createAiClient({
    apiKey: SENTINEL_KEY,
    fetchImpl: fetchMock as unknown as typeof fetch,
    timeoutMs: 50,
    now: () => (clock += 120),
  });
  return { client, fetchMock };
}

function sent(fetchMock: ReturnType<typeof vi.fn>): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  };
}

async function failure(client: AiClient, req: AiRequest = request()): Promise<AiClientError> {
  const error: unknown = await client.call(req).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AiClientError);
  return error as AiClientError;
}

describe('AI client: request shape', () => {
  it('sends tools with strict schemas, cache breakpoints, effort and the version header', async () => {
    const { client, fetchMock } = clientWith(async () => json(message()));
    const replay = [{ type: 'text', text: 'Earlier answer' }] as unknown as AiReplay;
    await client.call(
      request({
        messages: [
          { role: 'user', content: 'Earlier question' },
          { role: 'assistant', content: replay },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'toolu_0', content: 'not allowed', isError: true },
              { type: 'text', text: 'Try again' },
            ],
          },
        ],
        cacheConversation: '5m',
      }),
    );
    const { url, headers, body } = sent(fetchMock);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': SENTINEL_KEY,
      'anthropic-version': '2026-10-21',
    });
    expect(body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 2_048,
      output_config: { effort: 'low' },
      tool_choice: { type: 'auto' },
      tools: [
        {
          name: 'list_tasks',
          description: 'List tasks',
          input_schema: strict({}, []),
          strict: true,
        },
        {
          name: 'create_task',
          description: 'Create a task',
          input_schema: TASK_SCHEMA,
          strict: true,
          cache_control: { type: 'ephemeral' },
        },
      ],
      system: [
        {
          type: 'text',
          text: 'You are the TManage assistant.',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_0', content: 'not allowed', is_error: true },
            { type: 'text', text: 'Try again' },
          ],
        },
      ],
      cache_control: { type: 'ephemeral' },
    });
    expect(Object.keys(body)).not.toContain('thinking');
  });

  it('sends no tool fields when the request has no tools', async () => {
    const { client, fetchMock } = clientWith(async () =>
      json(message({ stop_reason: 'end_turn' })),
    );
    await client.call(request({ tools: [] }));
    expect(Object.keys(sent(fetchMock).body)).not.toEqual(expect.arrayContaining(['tools']));
    expect(sent(fetchMock).body['tool_choice']).toBeUndefined();
  });

  it.each([
    [
      'a model outside the price table',
      { model: 'claude-opus-5-5' as AiRequest['model'] },
      'unpriced_model',
    ],
    [
      'a forced tool that is not defined',
      { toolChoice: { type: 'tool', name: 'missing' } } as Partial<AiRequest>,
      'invalid_request',
    ],
    [
      // Claude Sonnet 5.5 answers a forced tool_choice with a 400: refused before it is sent.
      'a forced tool on a model that rejects forcing',
      {
        model: 'claude-sonnet-5-5',
        toolChoice: { type: 'tool', name: 'create_task' },
      } as Partial<AiRequest>,
      'invalid_request',
    ],
    [
      'a schema that allows extra fields',
      {
        tools: [
          {
            name: 'loose',
            description: 'x',
            inputSchema: {
              ...TASK_SCHEMA,
              additionalProperties: true,
            } as unknown as AiStrictSchema,
          },
        ],
      },
      'invalid_request',
    ],
    [
      'a nested object that is not strict',
      {
        tools: [
          {
            name: 'nested',
            description: 'x',
            inputSchema: strict({ inner: { type: 'object', properties: {} } }, ['inner']),
          },
        ],
      },
      'invalid_request',
    ],
    [
      'two tools with the same name',
      {
        tools: [
          { name: 'same', description: 'a', inputSchema: strict({}, []) },
          { name: 'same', description: 'b', inputSchema: strict({}, []) },
        ],
      },
      'invalid_request',
    ],
    [
      'more than four cache breakpoints',
      {
        system: [
          { text: 'a', cache: '1h' as const },
          { text: 'b', cache: '1h' as const },
          { text: 'c', cache: '5m' as const },
        ],
        cacheConversation: '5m' as const,
      },
      'invalid_request',
    ],
    ['a conversation that does not start with the user', { messages: [] }, 'invalid_request'],
    ['a non-positive max_tokens', { maxTokens: 0 }, 'invalid_request'],
  ] as const)('refuses %s before anything is sent', async (_name, overrides, kind) => {
    const { client, fetchMock } = clientWith(async () => json(message()));
    const error = await failure(client, request(overrides as Partial<AiRequest>));
    expect([error.kind, error.sent, fetchMock.mock.calls.length]).toEqual([kind, false, 0]);
  });
});

describe('AI client: response and usage', () => {
  it('returns text and tool calls, keeps thinking only for replay, and prices the usage', async () => {
    const { client } = clientWith(async () => json(message()));
    const result = await client.call(request());
    expect(result.stopReason).toBe('tool_use');
    expect(result.content).toEqual([
      { type: 'text', text: 'Creating the task.' },
      { type: 'tool_use', id: 'toolu_1', name: 'create_task', input: { title: 'Brief' } },
    ]);
    expect(result.replay).toHaveLength(3);
    expect(result.replay[0]).toEqual({ type: 'thinking', thinking: '', signature: 'sig-1' });
    expect(result.cost).toEqual({ microUsd: 350, priceTableVersion: AI_PRICE_TABLE_VERSION });
    expect(result.latencyMs).toBe(120);
  });

  it('splits cache writes by TTL and counts unattributed writes at the 1-hour rate', async () => {
    const { client } = clientWith(async () =>
      json(
        message({
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 3_000,
            cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 0 },
            cache_read_input_tokens: 40_000,
          },
        }),
      ),
    );
    const { usage } = await client.call(request());
    expect(usage).toEqual({
      inputTokens: 10,
      cacheWrite5mTokens: 1_000,
      cacheWrite1hTokens: 2_000,
      cacheReadTokens: 40_000,
      outputTokens: 20,
    });
  });

  it('reports a refusal as a stop reason, not as text', async () => {
    const { client } = clientWith(async () =>
      json(message({ stop_reason: 'refusal', content: [] })),
    );
    const result = await client.call(request());
    expect([result.stopReason, result.content]).toEqual(['refusal', []]);
  });
});

describe('AI client: failure paths', () => {
  it.each([
    [429, 'rate_limit_error', true],
    [529, 'overloaded_error', true],
    [400, 'invalid_request_error', false],
    [401, 'authentication_error', false],
  ])('a %i response is an http error (%s), retryable %s', async (status, type, retryable) => {
    const { client } = clientWith(async () =>
      json({ type: 'error', error: { type, message: 'details we do not repeat' } }, status),
    );
    const error = await failure(client);
    expect([error.kind, error.status, error.retryable, error.sent]).toEqual([
      'http',
      status,
      retryable,
      true,
    ]);
    expect(error.message).toBe(`provider responded ${status} (${type})`);
  });

  it('an error body that is not JSON still reports the status', async () => {
    const { client } = clientWith(
      async () => new Response('<html>bad gateway</html>', { status: 502 }),
    );
    const error = await failure(client);
    expect([error.kind, error.message, error.retryable]).toEqual([
      'http',
      'provider responded 502 (unknown_error)',
      true,
    ]);
  });

  it.each([
    ['a body that is not JSON', async () => new Response('not json', { status: 200 })],
    ['a message without usage', async () => json(message({ usage: undefined }))],
    ['an unknown stop reason', async () => json(message({ stop_reason: 'surprise' }))],
    [
      'an unknown content block',
      async () => json(message({ content: [{ type: 'image', source: {} }] })),
    ],
    [
      'a tool call without input',
      async () => json(message({ content: [{ type: 'tool_use', id: 't', name: 'n' }] })),
    ],
    [
      'a negative token count',
      async () => json(message({ usage: { input_tokens: -1, output_tokens: 1 } })),
    ],
  ])('%s is malformed', async (_name, respond) => {
    const { client } = clientWith(respond);
    const error = await failure(client);
    expect([error.kind, error.sent]).toEqual(['malformed', true]);
  });

  it('a request with no answer within the timeout is a retryable timeout', async () => {
    const { client } = clientWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
    );
    const error = await failure(client);
    expect([error.kind, error.retryable, error.sent, error.message]).toEqual([
      'timeout',
      true,
      true,
      'no response within 50 ms',
    ]);
  });

  it('a network failure names only the error class', async () => {
    const { client } = clientWith(async () => {
      throw new TypeError(`fetch failed for key ${SENTINEL_KEY}`);
    });
    const error = await failure(client);
    expect([error.kind, error.retryable, error.message]).toEqual([
      'network',
      true,
      'request failed (TypeError)',
    ]);
  });

  it('cannot be built without a key or with a non-positive timeout', () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(() => createAiClient({ apiKey: '  ', fetchImpl, timeoutMs: 10 })).toThrow(AiClientError);
    expect(() => createAiClient({ apiKey: SENTINEL_KEY, fetchImpl, timeoutMs: 0 })).toThrow(
      AiClientError,
    );
  });
});

describe('AI client: key hygiene', () => {
  it('the key never appears in the client, an error, a stack or the console', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const respond: ((url: string, init: RequestInit) => Promise<Response>)[] = [
      async () => json({ type: 'error', error: { type: 'authentication_error' } }, 401),
      async () => new Response('not json', { status: 200 }),
      async () => {
        throw new TypeError(`fetch failed ${SENTINEL_KEY}`);
      },
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error(SENTINEL_KEY)));
        }),
    ];
    const seen: string[] = [];
    for (const fetchImpl of respond) {
      const { client } = clientWith(fetchImpl);
      seen.push(String(client), JSON.stringify(client), Object.keys(client).join());
      const error = await failure(client);
      seen.push(error.message, String(error.stack), JSON.stringify(error), String(error));
    }
    const { client } = clientWith(async () => json(message()));
    seen.push(JSON.stringify(await client.call(request())));
    seen.push(...consoleSpies.flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args))));
    for (const spy of consoleSpies) spy.mockRestore();

    expect(seen.filter((text) => text.includes(SENTINEL_KEY))).toEqual([]);
    expect(seen.filter((text) => text.includes('SENTINEL'))).toEqual([]);
  });
});
