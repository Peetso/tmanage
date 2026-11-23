import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from '@tmanage/domain';
import { NEVER, findOpById, isNever } from './index.js';
import { parityDetails } from './parity-2026-11-23.js';
import { liveMcpSurface } from '../../mcp/catalog-runtime.js';
import { allDetailsById, buildToolCatalog, toolNameForOp } from '../../mcp/tool-catalog.js';
import { changeGateFor } from '../../copilot/ai-preview.js';
import { CHAT_FULL_SCOPES } from '../../copilot/copilot-chat.service.js';

/**
 * Parity pass, owner 2026-11-23: "both [the external MCP and the in-app AI] should do whatever the
 * account has the right to do". Batch 1 turns the iteration writes from NEVER into ops; this file
 * proves the round trip through the MCP tools (`run_action`), the member's own rights, the
 * confirm path, and that a granted `manage` scope really exposes manage ops to an external client.
 */

const BATCH_1 = [
  'iterations.create',
  'iterations.settings.set',
  'iterations.update',
  'iterations.items.move',
  'iterations.complete',
];
const OWNER = new Set<string>(capabilitiesFor('owner'));
const WITHOUT = (capability: string) => new Set<string>([...OWNER].filter((c) => c !== capability));
const ALL_GRANTED = 'tmanage:read tmanage:write tmanage:manage tmanage:billing';

function surface(scopes: string, capabilities: ReadonlySet<string>) {
  const fetched: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    fetched.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const frozen: { opId: string; args: unknown }[] = [];
  const { runtime, catalog } = liveMcpSurface({
    profile: 'compact',
    scopes,
    capabilities,
    orgSlug: 'northstar',
    baseUrl: 'http://in-process',
    fetch: fetchImpl,
    approvals: {
      service: {
        async request(_requester, opId, args) {
          frozen.push({ opId, args });
          return { id: 'pending_1', title: 'Complete an iteration', expiresAt: new Date() };
        },
        async check() {
          throw new Error('not used');
        },
      },
      requester: {
        organizationId: 'org_1',
        membershipId: 'mem_1',
        userId: 'usr_1',
        clientId: 'tmanage-ai',
        clientName: 'TManage AI',
      },
      webOrigin: 'https://tmanage.example',
      correlationId: 'corr_1',
    },
  });
  const run = (actionId: string, args: Record<string, unknown>) =>
    runtime.runTool(
      catalog.tools.find((t) => t.name === 'tmanage_run_action')!,
      {
        action_id: actionId,
        args,
      },
    );
  return { run, fetched, frozen };
}

describe('parity batch 1: the iteration writes are ops (were NEVER work_planning)', () => {
  it('each is an op with a detail and a sensitivity, and no longer in NEVER', () => {
    expect(parityDetails.map((d) => d.id)).toEqual(BATCH_1);
    for (const id of BATCH_1) {
      const op = findOpById(id);
      expect(op, id).toBeDefined();
      expect(allDetailsById.has(id), id).toBe(true);
      expect(isNever(op!.method, op!.path), id).toBe(false);
    }
    // Only the unsaved-rule preview stays: an existing op reads a saved rule's dates.
    expect(
      NEVER.filter((n) => (n.reason as string) === 'work_planning').map((n) => n.path),
    ).toEqual(['/v1/organizations/:orgSlug/work-items/:workItemId/recurrence/preview']);
  });

  it('round trip: run_action sends the parsed body to the route, as the member', async () => {
    const { run, fetched } = surface(CHAT_FULL_SCOPES, OWNER);
    const ran = await run('iterations.items.move', { iterationId: 'it_1', add: ['wi_1'] });
    expect(ran.isError).toBeUndefined();
    expect(fetched).toEqual([
      {
        url: 'http://in-process/v1/organizations/northstar/iterations/it_1/items',
        method: 'POST',
        body: { add: ['wi_1'] },
      },
    ]);
  });

  it('a confirm-class new op is frozen for approval, never run directly; always a card', async () => {
    const { run, fetched, frozen } = surface(CHAT_FULL_SCOPES, OWNER);
    const ran = await run('iterations.complete', { iterationId: 'it_1', moveUnfinishedTo: 'it_2' });
    expect(fetched).toEqual([]);
    expect(frozen).toEqual([
      { opId: 'iterations.complete', args: { iterationId: 'it_1', moveUnfinishedTo: 'it_2' } },
    ]);
    expect(ran.summary).toContain('https://tmanage.example');
    for (const id of BATCH_1) {
      const gate = changeGateFor(findOpById(id)!, { runAtOnce: true, hasUndo: true });
      // Manage-scope and confirm-class ones always ask; only the everyday move may run at once.
      expect(gate?.card, id).toBe(id !== 'iterations.items.move');
    }
  });

  it('without the right (project.manage), the member is refused and nothing is sent', async () => {
    const { run, fetched, frozen } = surface(CHAT_FULL_SCOPES, WITHOUT('project.manage'));
    const ran = await run('iterations.create', { projectId: 'pr_1', name: 'Sprint 5' });
    expect(ran).toMatchObject({
      isError: true,
      data: 'Unknown or not permitted action: iterations.create',
    });
    expect(fetched).toEqual([]);
    expect(frozen).toEqual([]);
  });
});

describe('an external MCP client reaches manage ops when the member grants manage', () => {
  it('granted every scope: manage ops are tools; read + write only: they are not', () => {
    const names = (scopes: string) =>
      new Set(
        buildToolCatalog({
          scopes: scopes.split(' ').map((s) => s.replace('tmanage:', '')) as never,
          capabilities: OWNER,
          profile: 'full',
        }).tools.map((t) => t.name),
      );
    const all = names(ALL_GRANTED);
    const narrow = names('tmanage:read tmanage:write');
    for (const id of ['invitations.create', 'iterations.create', 'client_organizations.create']) {
      expect(all.has(toolNameForOp(id)), id).toBe(true);
      expect(narrow.has(toolNameForOp(id)), id).toBe(false);
    }
  });
});
