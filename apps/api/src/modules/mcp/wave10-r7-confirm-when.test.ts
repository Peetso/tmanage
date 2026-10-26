import { describe, expect, it, vi } from 'vitest';
import { findOpById } from '../ai-actions/registry/index.js';
import { grantCoversOp, liveMcpSurface, opsCalledBy } from './catalog-runtime.js';

/**
 * Wave 10 R7 — audit run 2, N07, the MCP channel. An OAuth grant with only everyday read + write
 * consent must not make a client-facing change without a person's approval: a client-audience
 * work item and a client meeting attendee are refused like a confirm op, before any inner request
 * is made; a client-request message needs `manage`. Internal work and team attendees still run.
 */

const SCOPES = 'tmanage:read tmanage:write';
const CAPABILITIES = new Set([
  'work.read',
  'work.create',
  'work.update',
  'meeting.read',
  'meeting.write',
]);

function surface() {
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 'row-1' }), { status: 201 }),
  );
  const { runtime, catalog } = liveMcpSurface({
    profile: 'full',
    scopes: SCOPES,
    capabilities: CAPABILITIES,
    orgSlug: 'acme',
    baseUrl: 'http://in-process',
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  const tool = (opId: string) => {
    const found = catalog.tools.find((t) => t.opId === opId);
    if (found === undefined) throw new Error(`no tool for ${opId}`);
    return found;
  };
  return { runtime, fetch, tool };
}

describe('N07 — MCP: client-facing writes need approval under read + write consent', () => {
  it('work_items.create with audience client_visible is refused and makes no inner request', async () => {
    const { runtime, fetch, tool } = surface();
    const result = await runtime.runTool(tool('work_items.create'), {
      projectId: 'proj_1',
      title: 'Shown to the client',
      audience: 'client_visible',
    });
    expect(result.isError).toBe(true);
    expect(String(result.data)).toContain('needs your approval');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('client_action_required is refused too, and so is the same call through tmanage_run_action', async () => {
    const { runtime, fetch } = surface();
    const result = await runtime.runTool(
      { name: 'tmanage_run_action', title: '', description: '', inputSchema: {} } as never,
      {
        action_id: 'work_items.update',
        args: { workItemId: 'wi_1', audience: 'client_action_required' },
      },
    );
    expect(result.isError).toBe(true);
    expect(String(result.data)).toContain('needs your approval');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('work_items.create with audience internal (or no audience) still runs', async () => {
    const { runtime, fetch, tool } = surface();
    const internal = await runtime.runTool(tool('work_items.create'), {
      projectId: 'proj_1',
      title: 'Internal',
      audience: 'internal',
    });
    expect(internal.isError).toBeUndefined();
    const plain = await runtime.runTool(tool('work_items.create'), {
      projectId: 'proj_1',
      title: 'Default audience',
    });
    expect(plain.isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('meetings.attendees.create with clientUserId is refused; with userId it runs', async () => {
    const { runtime, fetch, tool } = surface();
    const client = await runtime.runTool(tool('meetings.attendees.create'), {
      meetingId: 'mtg_1',
      clientUserId: 'user_client',
    });
    expect(client.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    const member = await runtime.runTool(tool('meetings.attendees.create'), {
      meetingId: 'mtg_1',
      userId: 'user_3',
    });
    expect(member.isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('client_requests.messages.create is outside a write grant (insufficient_scope at the endpoint)', () => {
    const op = findOpById('client_requests.messages.create')!;
    expect(op.risk).toBe('confirm');
    expect(op.scope).toBe('manage');
    const called = opsCalledBy({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'tmanage_run_action',
        arguments: { action_id: 'client_requests.messages.create', args: {} },
      },
    });
    expect(called.map((o) => o.id)).toEqual(['client_requests.messages.create']);
    // The endpoint answers the 403 `insufficient_scope` challenge for exactly this.
    expect(grantCoversOp(SCOPES, op)).toBe(false);
    expect(grantCoversOp('tmanage:manage', op)).toBe(true);
  });
});
