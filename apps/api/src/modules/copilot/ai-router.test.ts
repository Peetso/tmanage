import { describe, expect, it, vi } from 'vitest';
import { createAiClient, FORCED_TOOL_CHOICE_MODELS, messagesBody } from './ai-client.js';
import { readResponse } from './ai-response.js';
import {
  parseRoute,
  ROUTE_TOOL_NAME,
  ROUTER_MAX_TOKENS,
  routeFailure,
  routerRequest,
} from './ai-router.js';
import { AI_TIER_SPECS } from './ai-tiers.js';

/**
 * AI-ROUTER-FIX (live 2026-11-23, workspace on the testing pool): every question stopped
 * `not_understood`. The router call succeeded, but `parseRoute` found no `route` call.
 *
 * Root cause: the router sent `tool_choice: auto` with `max_tokens: 128` to Claude Haiku 5.5,
 * which runs adaptive thinking by default; thinking counts toward `max_tokens`, so the reply
 * could stop at `max_tokens` after a thinking block and before any tool call (Anthropic, Claude
 * Haiku 5.5 migration notes: "Thinking counts toward max_tokens"; "Forced tool calls skip
 * thinking"). The bodies below have the documented Messages API shape for that model and go
 * through the same path as production: fetch body -> `readResponse` -> `parseRoute`.
 */

/** A documented-shape Messages API body of `claude-haiku-5-5`. */
const body = (stopReason: string, content: unknown[], outputTokens: number) => ({
  id: 'msg_01Router',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  stop_details: null,
  usage: {
    input_tokens: 12,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 640,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    output_tokens: outputTokens,
    service_tier: 'standard',
  },
});

/** Before the fix: thinking (text omitted by default) used the whole 128, no tool call. */
const CUT_BY_THINKING = body(
  'max_tokens',
  [{ type: 'thinking', thinking: '', signature: 'EqQBCkYIBxgCKkB' }],
  128,
);

/** After the fix: a forced call, no thinking block, one strict `route` call. */
const FORCED_ROUTE = body(
  'tool_use',
  [
    {
      type: 'tool_use',
      id: 'toolu_01Route',
      name: 'route',
      input: { domain: 'projects', tier: 'medium_high' },
    },
  ],
  38,
);

describe('the router against real-shaped Messages API replies', () => {
  it('reproduces the live failure: a reply cut by thinking parses to no route', () => {
    const response = readResponse(CUT_BY_THINKING);
    expect(parseRoute(response)).toBeNull();
    expect(routeFailure(response)).toEqual({
      stopReason: 'max_tokens',
      blockTypes: ['thinking'],
      routeCalls: 0,
      outputTokens: 128,
      invalidField: null,
    });
  });

  it('a forced route call parses', () => {
    expect(parseRoute(readResponse(FORCED_ROUTE))).toEqual({
      domain: 'projects',
      tier: 'medium_high',
    });
  });

  it('a route call with an unknown tier is refused and the failure names the field only', () => {
    const response = readResponse(
      body(
        'tool_use',
        [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'route',
            input: { domain: 'tasks', tier: 'ultra' },
          },
        ],
        30,
      ),
    );
    expect(parseRoute(response)).toBeNull();
    expect(routeFailure(response)).toMatchObject({ routeCalls: 1, invalidField: 'tier' });
    expect(JSON.stringify(routeFailure(response))).not.toContain('ultra');
  });
});

describe('the router request', () => {
  it('forces exactly one route call on a model that accepts forcing, with room to answer', () => {
    const request = routerRequest('Summarise my projects this week');
    expect(request.toolChoice).toEqual({ type: 'tool', name: ROUTE_TOOL_NAME });
    expect(FORCED_TOOL_CHOICE_MODELS.has(request.model)).toBe(true);
    // The task's model replaces the request's (callModel): the low tier must accept forcing too.
    expect(FORCED_TOOL_CHOICE_MODELS.has(AI_TIER_SPECS.low.model)).toBe(true);
    expect(request.maxTokens).toBeGreaterThanOrEqual(256);
    const wire = messagesBody(request);
    expect(wire['tool_choice']).toEqual({
      type: 'tool',
      name: 'route',
      disable_parallel_tool_use: true,
    });
    expect(wire['max_tokens']).toBe(ROUTER_MAX_TOKENS);
    expect((wire['tools'] as { strict?: boolean }[])[0]?.strict).toBe(true);
  });

  it('end to end through the client: the forced body is sent and the reply routes', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify(FORCED_ROUTE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = createAiClient({
      apiKey: 'sk-ant-test-router',
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 1_000,
    });
    const result = await client.call(routerRequest('How many projects and tasks do I have?'));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent['tool_choice']).toMatchObject({ type: 'tool', name: 'route' });
    expect(sent).not.toHaveProperty('thinking');
    expect(parseRoute(result)).toEqual({ domain: 'projects', tier: 'medium_high' });
  });
});
