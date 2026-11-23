import { describe, expect, it, vi } from 'vitest';
import type { CatalogTool } from '@tmanage/mcp-server';
import { liveMcpSurface } from './catalog-runtime.js';

/**
 * Owner 2026-11-23: "if he can't do anything let the ai say the reason why he can't". A refused
 * action names its reason (an owner setting / the connection's access, or a missing right), and
 * tmanage_find_actions lists matching actions the account cannot run here under `not_allowed`.
 */
const meta = (name: string): CatalogTool =>
  ({
    name,
    title: name,
    description: '',
    inputSchema: { type: 'object' },
  }) as unknown as CatalogTool;

function surface(scopes: string, capabilities: string[]) {
  const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
  return liveMcpSurface({
    profile: 'full',
    scopes,
    capabilities: new Set(capabilities),
    orgSlug: 'acme',
    baseUrl: 'http://in-process',
    fetch: fetch as unknown as typeof globalThis.fetch,
  }).runtime;
}

describe('MCP runtime — the reason an action cannot run', () => {
  it('a read-only grant names the owner setting when asked to create a project', async () => {
    const runtime = surface('tmanage:read', ['project.create', 'project.read']);
    const result = await runtime.runTool(meta('tmanage_run_action'), {
      action_id: 'projects.create',
      args: { name: 'X' },
    });
    expect(result.isError).toBe(true);
    expect(String(result.data)).toContain('Answer questions only');
  });

  it('a missing right is named, with where an admin gives it', async () => {
    const runtime = surface('tmanage:read tmanage:write', ['project.read']);
    const result = await runtime.runTool(meta('tmanage_run_action'), {
      action_id: 'projects.create',
      args: { name: 'X' },
    });
    expect(result.isError).toBe(true);
    expect(String(result.data)).toContain('"project.create"');
    expect(String(result.data)).toContain('Admin > Roles');
  });

  it('find lists a matching action the account cannot run under not_allowed, with the reason', async () => {
    const runtime = surface('tmanage:read', ['project.create', 'project.read']);
    const result = await runtime.runTool(meta('tmanage_find_actions'), {
      query: 'create a new project',
    });
    const data = result.data as { not_allowed?: { action_id: string; reason: string }[] };
    const entry = data.not_allowed?.find((a) => a.action_id === 'projects.create');
    expect(entry?.reason).toContain('Answer questions only');
  });
});
