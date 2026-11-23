import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { capabilitiesFor } from '@tmanage/domain';
import { OPS, OP_SENSITIVITY, findOpById, isNever, routeKey } from './index.js';
import { securityDetails, securityOps } from './parity-b2-security.js';
import { filesDetails, filesOps } from './parity-b2-files.js';
import { workDetails, workOps } from './parity-b2-work.js';
import { liveMcpSurface } from '../../mcp/catalog-runtime.js';
import { allDetailsById, allDetailsList } from '../../mcp/tool-catalog.js';
import { changeGateFor } from '../../copilot/ai-preview.js';
import { CHAT_FULL_SCOPES } from '../../copilot/copilot-chat.service.js';

/**
 * Parity batch 2, owner 2026-11-23: "both [the external MCP and the in-app AI] should do whatever
 * the account has the right to do". 228 workspace routes left NEVER without an ADR-0015 K1-K5
 * reason are ops now, and the 45 ops that had no detail have one (bar the two below). This file
 * is the fitness function: every new change is confirm-class, every detail is strict and accepts
 * its own examples, no op is silently detail-less, and the routes kept out stay out.
 */

const ORG = '/v1/organizations/:orgSlug';
const BATCH_2_OPS = [...securityOps, ...filesOps, ...workOps];
const BATCH_2_DETAILS = [...securityDetails, ...filesDetails, ...workDetails];

/** Ops that keep no detail on purpose (so no tool reaches them), with the reason. */
const DETAIL_LESS_ON_PURPOSE: Readonly<Record<string, string>> = {
  'realtime.tickets.create': 'K1 mints a signed socket ticket (a session credential)',
  'upload_sessions.create':
    'needs an Idempotency-Key header the tool call cannot send; the bytes go over a NEVER route',
};

/** The routes of the batch that stay NEVER, each for an ADR-0015 reason (see the batch report). */
const KEPT: readonly (readonly [string, string])[] = [
  // K1: the data-rights routes refuse any principal but a person's cookie session (+ step-up).
  ['POST', `${ORG}/admin/privacy/exports`],
  ['GET', `${ORG}/admin/privacy/exports/:exportId/download`],
  ['POST', `${ORG}/admin/privacy/deletion`],
  ['POST', `${ORG}/admin/privacy/deletion/cancel`],
  ['POST', `${ORG}/me/privacy/exports`],
  ['GET', `${ORG}/me/privacy/exports/:exportId/download`],
  ['POST', `${ORG}/me/privacy/deletion`],
  ['POST', `${ORG}/me/privacy/deletion/cancel`],
  // K1: a password step-up header the in-process call cannot carry; K3 a stored client secret.
  ['PUT', `${ORG}/security/sign-in-policy`],
  ['PUT', `${ORG}/security/sso/`],
  ['POST', `${ORG}/finance/exports/`],
  ['PUT', `${ORG}/finance/einvoicing/certificate`],
  ['DELETE', `${ORG}/finance/einvoicing/certificate`],
  // K2: AI employees are changed by a person only (`requirePersonSession`); the agent's own view.
  ['GET', `${ORG}/ai-employees/`],
  ['POST', `${ORG}/ai-employees/`],
  ['GET', `${ORG}/ai-employees/:aiEmployeeId`],
  ['PATCH', `${ORG}/ai-employees/:aiEmployeeId`],
  ['POST', `${ORG}/ai-employees/:aiEmployeeId/pause`],
  ['POST', `${ORG}/ai-employees/:aiEmployeeId/resume`],
  ['POST', `${ORG}/ai-employees/:aiEmployeeId/retire`],
  ['POST', `${ORG}/ai-employees/:aiEmployeeId/sponsor`],
  ['GET', `${ORG}/ai-employees/excluded-projects`],
  ['PUT', `${ORG}/ai-employees/excluded-projects/:projectId`],
  ['DELETE', `${ORG}/ai-employees/excluded-projects/:projectId`],
  ['GET', `${ORG}/agent/me`],
  // K3: a raw secret in the answer (feed address, signing secret, group invite token).
  ['POST', `${ORG}/calendar-sync/feed`],
  ['POST', `${ORG}/integrations/github/repo-hooks`],
  ['GET', `${ORG}/conversations/:conversationId/group/`],
];

const OWNER = new Set<string>(capabilitiesFor('owner'));

function surface(capabilities: ReadonlySet<string>) {
  const fetched: { url: string; method: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    fetched.push({ url: String(url), method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const frozen: { opId: string; args: unknown }[] = [];
  const { runtime, catalog } = liveMcpSurface({
    profile: 'compact',
    scopes: CHAT_FULL_SCOPES,
    capabilities,
    orgSlug: 'northstar',
    baseUrl: 'http://in-process',
    fetch: fetchImpl,
    approvals: {
      service: {
        async request(_requester, opId, args) {
          frozen.push({ opId, args });
          return { id: 'pending_1', title: 'An action', expiresAt: new Date() };
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

describe('parity batch 2: the remaining workspace routes are ops', () => {
  it('each new op has a detail, is out of NEVER, and every change is confirm-class', () => {
    expect(BATCH_2_OPS).toHaveLength(228);
    for (const op of BATCH_2_OPS) {
      expect(findOpById(op.id), op.id).toBe(op);
      expect(allDetailsById.has(op.id), op.id).toBe(true);
      expect(isNever(op.method, op.path), op.id).toBe(false);
      if (op.method === 'GET') {
        expect([op.risk, op.scope], op.id).toEqual(['read', 'read']);
      } else {
        expect(op.risk, op.id).toBe('confirm');
        expect(OP_SENSITIVITY[op.id], op.id).toBeDefined();
        if (op.capability?.startsWith('billing.')) expect(op.scope, op.id).toBe('billing');
      }
    }
  });

  it('every change of the batch always asks on a card, even with run at once', () => {
    for (const op of BATCH_2_OPS.filter((o) => o.risk !== 'read')) {
      expect(changeGateFor(op, { runAtOnce: true, hasUndo: true })?.card, op.id).toBe(true);
    }
  });

  it('every batch detail binds its path params, is strict and accepts its own examples', () => {
    for (const d of BATCH_2_DETAILS) {
      const op = findOpById(d.id);
      expect(op, `detail without an op: ${d.id}`).toBeDefined();
      const shape = (d.input as z.ZodObject<z.ZodRawShape>).shape;
      for (const seg of op!.path.split('/')) {
        if (seg.startsWith(':') && seg !== ':orgSlug')
          expect(shape, d.id).toHaveProperty(seg.slice(1));
      }
      expect(d.examples.length, d.id).toBeGreaterThan(0);
      for (const ex of d.examples) {
        expect(d.input.safeParse(ex.args).success, `${d.id}: ${ex.summary}`).toBe(true);
      }
      expect(d.input.safeParse({ ...d.examples[0]!.args, unknownKey: 'x' }).success, d.id).toBe(
        false,
      );
      expect(d.description.length, d.id).toBeGreaterThan(20);
    }
  });

  it('no detail id is written twice, and no op is detail-less except on purpose', () => {
    const ids = allDetailsList.map((d) => d.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    const aiSelf = /\/(copilot|ai)(\/|$)/;
    const detailLess = OPS.filter((op) => !allDetailsById.has(op.id) && !aiSelf.test(op.path));
    expect(detailLess.map((op) => op.id).sort()).toEqual(
      Object.keys(DETAIL_LESS_ON_PURPOSE).sort(),
    );
  });

  it('the routes kept out for a K1-K3 reason stay NEVER', () => {
    for (const [method, path] of KEPT) {
      expect(isNever(method, path), `${method} ${path}`).toBe(true);
      expect(
        OPS.some((op) => routeKey(op.method, op.path) === routeKey(method, path)),
        path,
      ).toBe(false);
    }
  });

  it('round trip: a read runs as the member; a change is frozen for approval, nothing sent', async () => {
    const read = surface(OWNER);
    const got = await read.run('finance.profile.get', {});
    expect(got.isError).toBeUndefined();
    expect(read.fetched).toEqual([
      { url: 'http://in-process/v1/organizations/northstar/finance/profile', method: 'GET' },
    ]);

    const change = surface(OWNER);
    const asked = await change.run('admin.ip_allowlist.create', {
      cidr: '203.0.113.0/24',
      label: 'Office',
    });
    expect(change.fetched).toEqual([]);
    expect(change.frozen).toEqual([
      { opId: 'admin.ip_allowlist.create', args: { cidr: '203.0.113.0/24', label: 'Office' } },
    ]);
    expect(asked.summary).toContain('https://tmanage.example');
  });

  it('without the right (org.security.manage), the member is refused and nothing is sent', async () => {
    const without = new Set([...OWNER].filter((c) => c !== 'org.security.manage'));
    const { run, fetched, frozen } = surface(without);
    const ran = await run('admin.ip_allowlist.create', { cidr: '203.0.113.0/24' });
    // ae3933fe: a refusal names its reason (the missing right) instead of "unknown".
    expect(ran.isError).toBe(true);
    expect(String(ran.data)).toContain('Not permitted: admin.ip_allowlist.create.');
    expect(String(ran.data)).toContain('"org.security.manage"');
    expect(fetched).toEqual([]);
    expect(frozen).toEqual([]);
  });
});
