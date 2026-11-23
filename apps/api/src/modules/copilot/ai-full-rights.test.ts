import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from '@tmanage/domain';
import { OPS } from '../ai-actions/registry/index.js';
import { grantCoversOp, liveMcpSurface } from '../mcp/catalog-runtime.js';
import { META_TOOL_NAMES } from './ai-chat-tools.js';
import { CHAT_FULL_SCOPES, chatScopesFor } from './copilot-chat.service.js';

/**
 * Owner 2026-11-23: "the AI should do anything that I can do". The in-app chat runs with the
 * member's full rights when the owner allows changes; what a member may reach is still decided by
 * their own capabilities (the surface's catalogue here, the API's `@RequireCapability` behind it),
 * and a confirm-class op such as an invitation never runs from the surface itself (its card's
 * approval runs it). External MCP and OAuth grants keep exactly the scopes they were given.
 */

const OWNER = new Set<string>(capabilitiesFor('owner'));
/** A member who may not manage the workspace: the owner's rights without `org.manage`. */
const NO_MANAGE = new Set<string>([...OWNER].filter((c) => c !== 'org.manage'));

function surface(scopes: string, capabilities: ReadonlySet<string>) {
  const fetched: string[] = [];
  const fetchImpl = (async (url: string) => {
    fetched.push(String(url));
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const { runtime, catalog } = liveMcpSurface({
    profile: 'compact',
    scopes,
    capabilities,
    orgSlug: 'northstar',
    baseUrl: 'http://in-process',
    fetch: fetchImpl,
  });
  const run = (name: string, args: Record<string, unknown>) => {
    const tool = catalog.tools.find((t) => t.name === name)!;
    return runtime.runTool(tool, args);
  };
  return { run, fetched };
}

const INVITE = {
  email: 'tmanageorg@gmail.com',
  role: 'member',
  clientOrganizationId: null,
};

describe('the in-app chat runs with the member’s full rights (owner 2026-11-23)', () => {
  it('read_write grants every scope; the read-only owner setting stays read only', () => {
    expect(chatScopesFor('read_write')).toBe(CHAT_FULL_SCOPES);
    expect(CHAT_FULL_SCOPES.split(' ').sort()).toEqual([
      'tmanage:billing',
      'tmanage:manage',
      'tmanage:read',
      'tmanage:write',
    ]);
    expect(chatScopesFor('read')).toBe('tmanage:read');
    const invite = OPS.find((op) => op.id === 'invitations.create')!;
    expect(grantCoversOp(chatScopesFor('read_write'), invite)).toBe(true);
    expect(grantCoversOp(chatScopesFor('read'), invite)).toBe(false);
  });

  it('a member with org.manage may reach invitations.create; it never runs from the surface', async () => {
    const { run, fetched } = surface(CHAT_FULL_SCOPES, OWNER);
    const described = await run(META_TOOL_NAMES.describe, { action_id: 'invitations.create' });
    expect(described.isError).toBeUndefined();
    expect(described.data).toMatchObject({ action_id: 'invitations.create', risk: 'confirm' });
    const ran = await run(META_TOOL_NAMES.run, { action_id: 'invitations.create', args: INVITE });
    // Confirm-class: no inner request; only the card's approval runs it, as the member.
    expect(ran.isError).toBe(true);
    expect(fetched).toEqual([]);
  });

  it('a member without org.manage is refused plainly, and no request is made', async () => {
    const { run, fetched } = surface(CHAT_FULL_SCOPES, NO_MANAGE);
    for (const id of ['invitations.create', 'invitations.list', 'client_organizations.list']) {
      const described = await run(META_TOOL_NAMES.describe, { action_id: id });
      // Fix lane A 2026-11-23: the refusal names the missing right, not "unknown or not permitted".
      expect(described.isError, id).toBe(true);
      expect(String(described.data), id).toContain(`Not allowed here: ${id}. Your role`);
    }
    const ran = await run(META_TOOL_NAMES.run, { action_id: 'invitations.create', args: INVITE });
    expect(ran).toMatchObject({ isError: true });
    expect(fetched).toEqual([]);
  });

  it('an external grant of read + write still cannot reach a manage op (unchanged)', async () => {
    const { run, fetched } = surface('tmanage:read tmanage:write', OWNER);
    const described = await run(META_TOOL_NAMES.describe, { action_id: 'invitations.create' });
    expect(described.isError).toBe(true);
    expect(fetched).toEqual([]);
  });
});
