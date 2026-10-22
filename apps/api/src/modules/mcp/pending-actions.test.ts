import { describe, expect, it, vi } from 'vitest';
import type { AiActionOp } from '../ai-actions/registry/index.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PendingAiActionRow } from '../../common/database/schema.js';
import {
  approvalIdFromRetry,
  approvalRequiredResult,
  buildOpRequest,
  effectiveStatus,
  freezeConfirmAction,
  signRequestState,
  subjectFromArgs,
} from './pending-actions.js';
import { PendingAiActionsService } from './pending-actions.service.js';
import type { PendingAiActionsRepository } from './pending-actions.repository.js';
import { requireCookieSession } from './pending-actions.controller.js';

const KEY = 'test-request-state-key';
const NOW = new Date('2026-10-22T12:00:00.000Z');

const context = {
  organizationId: 'org-1',
  userId: 'user-1',
  membershipId: 'mem-1',
  correlationId: 'corr-1',
} as unknown as TenantContext;

const database = {
  read: (_c: unknown, fn: (runner: unknown) => unknown) => fn({}),
  transaction: (_c: unknown, fn: (runner: unknown) => unknown) => fn({}),
} as unknown as TenantDatabase;

function storedRow(overrides: Partial<PendingAiActionRow> = {}): PendingAiActionRow {
  const frozen = freezeConfirmAction('work_items.delete', { workItemId: 'wi_1' });
  return {
    id: 'pa-1',
    organizationId: 'org-1',
    membershipId: 'mem-1',
    userId: 'user-1',
    clientId: 'pat:1',
    clientName: 'Claude',
    opId: 'work_items.delete',
    argsJson: frozen.args,
    argsSha256: frozen.argsSha256,
    status: 'pending',
    expiresAt: new Date(NOW.getTime() + 60_000),
    decidedAt: null,
    resultStatus: null,
    resultJson: null,
    createdAt: NOW,
    ...overrides,
  };
}

function serviceWith(row: PendingAiActionRow | undefined, decided: number) {
  const execute = vi.fn(async () => ({ status: 204, body: '' }));
  const repository = {
    insert: vi.fn(async () => undefined),
    findOwn: vi.fn(async () =>
      row === undefined ? undefined : { row, memberName: 'Maya Hassan', memberEmail: 'm@x.test' },
    ),
    decide: vi.fn(async () => decided),
    recordResult: vi.fn(async () => undefined),
  } as unknown as PendingAiActionsRepository;
  const service = new PendingAiActionsService(database, execute, repository, () => NOW);
  return { service, execute, repository };
}

describe('pending AI actions (S10)', () => {
  it('T-APR-01: freezes only confirm-class ops with schema-valid args, and never runs on request', async () => {
    expect(() => freezeConfirmAction('work_items.create', {})).toThrow(/does not need approval/);
    expect(() => freezeConfirmAction('work_items.delete', { workItemId: 'x', extra: 1 })).toThrow(
      /Invalid arguments/,
    );
    const { service, execute, repository } = serviceWith(undefined, 0);
    const created = await service.request(
      {
        organizationId: '01890000-0000-7000-8000-000000000001',
        membershipId: 'mem-1',
        userId: 'user-1',
        clientId: 'pat:1',
        clientName: 'Claude',
      },
      'work_items.delete',
      { workItemId: 'wi_1' },
      '01890000-0000-7000-8000-000000000002',
    );
    expect(created.expiresAt.getTime() - NOW.getTime()).toBe(10 * 60 * 1000);
    expect(repository.insert).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it('T-APR-02: refuses another member (404) and any non-cookie session (403)', async () => {
    const { service } = serviceWith(undefined, 0);
    await expect(service.view(context, 'pa-1')).rejects.toMatchObject({ status: 404 });
    expect(() => requireCookieSession('personal_access_token')).toThrow();
    expect(() => requireCookieSession('ai_grant')).toThrow();
    expect(() => requireCookieSession(undefined)).toThrow();
    expect(() => requireCookieSession('cookie')).not.toThrow();
  });

  it('T-APR-03: runs the frozen op once as the same member; a lost transition runs nothing', async () => {
    const winner = serviceWith(storedRow(), 1);
    await winner.service.approve(context, 'studio', 'pa-1');
    expect(winner.execute).toHaveBeenCalledOnce();
    expect(winner.execute).toHaveBeenCalledWith(
      { method: 'DELETE', url: '/v1/organizations/studio/work-items/wi_1' },
      expect.objectContaining({
        userId: 'user-1',
        membershipId: 'mem-1',
        opId: 'work_items.delete',
      }),
      'corr-1',
    );

    const repeat = serviceWith(storedRow({ status: 'approved' }), 0);
    await repeat.service.approve(context, 'studio', 'pa-1');
    expect(repeat.execute).not.toHaveBeenCalled();
  });

  it('T-APR-03: refuses tampered args and reads a lapsed request as expired', async () => {
    const tampered = serviceWith(storedRow({ argsJson: { workItemId: 'wi_2' } }), 1);
    await expect(tampered.service.approve(context, 'studio', 'pa-1')).rejects.toMatchObject({
      status: 404,
    });
    expect(tampered.execute).not.toHaveBeenCalled();
    expect(effectiveStatus({ status: 'pending', expiresAt: NOW }, NOW)).toBe('expired');
  });

  it('T-APR-04: a client-forged elicitation answer or requestState never names an approval', () => {
    const state = signRequestState('pa-1', KEY);
    expect(approvalIdFromRetry({ requestState: state }, KEY)).toBe('pa-1');
    expect(approvalIdFromRetry({ requestState: 'pa-2.forged' }, KEY)).toBeUndefined();
    expect(
      approvalIdFromRetry({ inputResponses: { approval: { action: 'accept' } } }, KEY),
    ).toBeUndefined();
  });

  it('answers with MRTR URL elicitation when supported, else a pending link', () => {
    const base = {
      id: 'pa-1',
      url: 'https://t.test/studio/ai/approve/pa-1',
      expiresAt: NOW,
      title: 'Delete work item',
      requestState: 'pa-1.sig',
    };
    const mrtr = approvalRequiredResult({ ...base, supportsUrlElicitation: true });
    expect(mrtr).toMatchObject({
      resultType: 'input_required',
      inputRequests: { approval: { params: { mode: 'url', url: base.url } } },
    });
    const link = approvalRequiredResult({ ...base, supportsUrlElicitation: false });
    expect(link).toMatchObject({ isError: false, structuredContent: { status: 'pending' } });
    expect(JSON.stringify(link)).toContain(base.url);
  });

  it('builds the inject request: encoded path params, JSON body for the rest', () => {
    const op = {
      id: 'x.send',
      method: 'POST',
      path: '/v1/organizations/:orgSlug/things/:thingId/send',
      capability: null,
      risk: 'confirm',
      scope: 'manage',
    } as AiActionOp;
    expect(buildOpRequest(op, { thingId: 'a/b', note: 'hi' }, 'studio')).toEqual({
      method: 'POST',
      url: '/v1/organizations/studio/things/a%2Fb/send',
      body: '{"note":"hi"}',
    });
  });

  it('names the target for the bold line: from a name-like arg, else by reading it as the member', async () => {
    expect(subjectFromArgs({ email: 'sam@x.test', role: 'member' })).toBe('sam@x.test');
    expect(subjectFromArgs({ workItemId: 'wi_1' })).toBeNull();

    const { service, execute } = serviceWith(storedRow(), 0);
    execute.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ id: 'wi_1', title: 'Homepage direction review' }),
    });
    const view = await service.view(context, 'pa-1', 'studio');
    expect(view.summary.subject).toBe('Homepage direction review');
    expect(execute).toHaveBeenCalledWith(
      { method: 'GET', url: '/v1/organizations/studio/work-items/wi_1' },
      expect.objectContaining({ opId: 'work_items.get', membershipId: 'mem-1' }),
      'corr-1',
    );

    execute.mockResolvedValueOnce({ status: 404, body: '{}' });
    expect((await service.view(context, 'pa-1', 'studio')).summary.subject).toBeNull();
  });
});
