import { describe, expect, it, vi } from 'vitest';
import type { HttpAdapterHost } from '@nestjs/core';
import { z } from 'zod';
import { requireRequestState } from '../../common/http/request-state.js';
import { McpEndpointController } from './mcp-endpoint.controller.js';
import {
  MCP_MAX_ARRAY_ITEMS,
  MCP_MAX_DEPTH,
  MCP_MAX_JSON_VALUES,
  MCP_MAX_OBJECT_KEYS,
  mcpBodyShapeRefusal,
} from './mcp-body-shape.js';

/**
 * Audit run 2, NO-GO reason 1 (GHSA-mrhx-c7xc-m3w5, zod 3.25.76): zod keeps validating every
 * element of a collection after its `.max()` failed, so the cost follows the input, not the schema.
 * The bundle accepts that advisory only because no oversized collection reaches zod: `POST /mcp`
 * refuses the body's shape first.
 */

function toolCall(args: Record<string, unknown>): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'tmanage_run_action', arguments: { action_id: 'work_items.list', args } },
  };
}

describe('GHSA-mrhx-c7xc-m3w5 — the mechanism the cap answers', () => {
  it('zod 3 reports one issue per element of an oversized array, not one for the max', () => {
    const schema = z.array(z.string().max(64)).max(500);
    const result = schema.safeParse(Array.from({ length: 5_000 }, () => 1));
    expect(result.success).toBe(false);
    // The work (and memory) is per element: the max is not a short circuit.
    expect(result.error?.issues.length).toBeGreaterThan(5_000);
  });
});

describe('mcpBodyShapeRefusal', () => {
  it('passes an ordinary tool call, and the largest collection the catalogue allows', () => {
    expect(mcpBodyShapeRefusal({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBeUndefined();
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    expect(mcpBodyShapeRefusal(toolCall({ ids }))).toBeUndefined();
  });

  it('refuses an array over the cap', () => {
    const ids = Array.from({ length: MCP_MAX_ARRAY_ITEMS + 1 }, () => 'x');
    expect(mcpBodyShapeRefusal(toolCall({ ids }))).toBe('array_too_long');
  });

  it('refuses an object with too many keys (a z.record payload)', () => {
    const config = Object.fromEntries(
      Array.from({ length: MCP_MAX_OBJECT_KEYS + 1 }, (_, i) => [`k${i}`, 1]),
    );
    expect(mcpBodyShapeRefusal(toolCall({ config }))).toBe('object_too_wide');
  });

  it('refuses many collections that are each under the cap but too many values together', () => {
    const chunks = Array.from({ length: 30 }, () =>
      Array.from({ length: MCP_MAX_ARRAY_ITEMS }, () => 0),
    );
    expect(30 * MCP_MAX_ARRAY_ITEMS).toBeGreaterThan(MCP_MAX_JSON_VALUES);
    expect(mcpBodyShapeRefusal(toolCall({ chunks }))).toBe('too_many_values');
  });

  it('refuses nesting deeper than the cap', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < MCP_MAX_DEPTH + 1; i += 1) deep = [deep];
    expect(mcpBodyShapeRefusal(deep)).toBe('too_deep');
  });
});

describe('POST /mcp refuses an oversized collection before zod or the workspace runs', () => {
  function patRequest(body: unknown): never {
    const request = {
      method: 'POST',
      headers: { authorization: 'Bearer tm_pat_x' },
      body,
      raw: {} as never,
    };
    const state = requireRequestState(request);
    state.session = { sessionId: 'pat:r9', userId: '0198f4a2-1c00-7000-8000-0000000000r9' };
    state.authScheme = 'personal_access_token';
    state.personalAccessToken = { organizationId: 'org-1', membershipId: 'mem-1' };
    return request as never;
  }

  function endpoint(resolve: ReturnType<typeof vi.fn>): McpEndpointController {
    const host = { httpAdapter: { getInstance: () => ({}) } } as unknown as HttpAdapterHost;
    return new McpEndpointController(host, undefined, { resolve } as never);
  }

  it('exploit: a 100,000-item argument array is a 400, and nothing past the cap runs', async () => {
    const resolve = vi.fn(async () => undefined);
    const reply = { hijack: vi.fn(), raw: {} } as never;
    const ids = Array.from({ length: 100_000 }, () => 'x');
    await expect(
      endpoint(resolve).handle(patRequest(toolCall({ ids })), reply),
    ).rejects.toMatchObject({
      status: 400,
      code: 'validation_failed',
      auditCode: 'mcp_body_array_too_long',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('an ordinary body passes the cap and reaches the workspace check', async () => {
    const resolve = vi.fn(async () => undefined);
    const reply = { hijack: vi.fn(), raw: {} } as never;
    await expect(
      endpoint(resolve).handle(patRequest(toolCall({ ids: ['a', 'b'] })), reply),
    ).rejects.toMatchObject({ status: 401 });
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
