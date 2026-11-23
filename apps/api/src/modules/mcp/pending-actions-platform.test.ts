import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PendingAiActionRow } from '../../common/database/schema.js';
import { approvalGateOf, freezeConfirmAction } from './pending-actions.js';
import { PLATFORM_PROPOSALS_PER_HOUR, PendingAiActionsService } from './pending-actions.service.js';
import type { PendingAiActionsRepository } from './pending-actions.repository.js';
import type { InternalGrantPayload } from './internal-grant.js';

/**
 * ADR-0015 part 2 — a platform change the AI proposes waits for the platform admin's approval
 * (F3), asks for the password again on the riskiest ones (F5), runs bound to the approving
 * browser session with the pending action named (F10), and the proposals are capped (F1).
 */

const NOW = new Date('2026-11-23T10:00:00.000Z');
const ORG = '0199aa00-0000-7000-8000-00000000c001';

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

const CORR = '0199aa00-0000-7000-8000-00000000c0cc';
const SUSPEND_ARGS = { organizationId: ORG, reason: 'Phishing pages hosted in client portal' };

function rowFor(opId: string, args: Record<string, unknown>): PendingAiActionRow {
  const frozen = freezeConfirmAction(opId, args);
  return {
    id: 'pa-1',
    organizationId: 'org-1',
    membershipId: 'mem-1',
    userId: 'user-1',
    clientId: 'tmanage-ai',
    clientName: 'TManage AI',
    opId,
    argsJson: frozen.args,
    argsSha256: frozen.argsSha256,
    status: 'pending',
    expiresAt: new Date(NOW.getTime() + 60_000),
    decidedAt: null,
    resultStatus: null,
    resultJson: null,
    createdAt: NOW,
  };
}

function serviceFor(row: PendingAiActionRow) {
  const execute = vi.fn(async (_request: unknown, _grant: InternalGrantPayload) => ({
    status: 200,
    body: '{"name":"Acme Ltd"}',
  }));
  const repository = {
    findOwn: vi.fn(async () => ({ row, memberName: 'Peter', memberEmail: 'p@x.test' })),
    decide: vi.fn(async () => 1),
    recordResult: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
  } as unknown as PendingAiActionsRepository;
  const service = new PendingAiActionsService(database, execute, repository, () => NOW);
  return { service, execute, repository };
}

const SUSPEND = rowFor('platform.orgs.suspend', SUSPEND_ARGS);

describe('F5 — the riskiest platform changes need the password again at approval', () => {
  it('a company suspension is step_up; a bare approve is refused and nothing runs', async () => {
    const frozen = freezeConfirmAction('platform.orgs.suspend', SUSPEND_ARGS);
    expect(approvalGateOf(frozen.op, frozen.args).confirmation).toBe('step_up');
    const { service, execute, repository } = serviceFor(SUSPEND);
    await expect(
      service.approveInPerson(context, 'acme', 'pa-1', {
        stepUpFresh: false,
        amount: undefined,
        sessionId: 'browser-1',
      }),
    ).rejects.toMatchObject({ status: 403, code: 'reauthentication_required' });
    expect(repository.decide).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('an ordinary platform change (an announcement) approves without it', () => {
    const frozen = freezeConfirmAction('platform.announcements.create', {
      titleEn: 'Maintenance tonight',
      bodyEn: 'TManage is down for ten minutes at 22:00.',
      severity: 'info',
    });
    expect(approvalGateOf(frozen.op, frozen.args).confirmation).toBe('none');
  });
});

describe('F3/F10 — an approved platform change runs bound to the approving session', () => {
  it('passes the approving session and the pending action id to the inner grant', async () => {
    const { service, execute } = serviceFor(SUSPEND);
    await service.approveInPerson(context, 'acme', 'pa-1', {
      stepUpFresh: true,
      amount: undefined,
      sessionId: 'browser-1',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const [request, grant] = execute.mock.calls[0]!;
    expect(request).toMatchObject({
      method: 'POST',
      url: `/v1/platform/organizations/${ORG}/suspension`,
    });
    expect(grant).toMatchObject({
      opId: 'platform.orgs.suspend',
      stepUpSessionId: 'browser-1',
      pendingActionId: 'pa-1',
      clientName: 'TManage AI',
    });
  });

  it('a tenant op never gets a platform binding, even from a cookie approve', async () => {
    const { service, execute } = serviceFor(rowFor('work_items.delete', { workItemId: 'wi-1' }));
    await service.approveInPerson(context, 'acme', 'pa-1', {
      stepUpFresh: false,
      amount: undefined,
      sessionId: 'browser-1',
    });
    const grant = execute.mock.calls[0]![1];
    expect(grant.stepUpSessionId).toBeUndefined();
    expect(grant.pendingActionId).toBeUndefined();
  });
});

describe('F9 — the approve page of a platform change', () => {
  it('shows the platform block and names the company by the platform read', async () => {
    const { service, execute } = serviceFor(SUSPEND);
    const view = await service.view(context, 'pa-1', 'acme', 'browser-1');
    expect(view.summary.platform).toEqual({
      permission: 'platform.orgs.lifecycle',
      secondAdminWhenPolicyOn: true,
      reason: SUSPEND_ARGS.reason,
      reasonDraftedByAi: true,
    });
    expect(view.summary.subject).toBe('Acme Ltd');
    const [request, grant] = execute.mock.calls[0]!;
    expect(request).toMatchObject({ method: 'GET', url: `/v1/platform/organizations/${ORG}` });
    expect(grant).toMatchObject({ opId: 'platform.orgs.get', stepUpSessionId: 'browser-1' });
  });

  it('names nothing without a viewing cookie session (no unbound platform read)', async () => {
    const { service, execute } = serviceFor(SUSPEND);
    const view = await service.view(context, 'pa-1', 'acme');
    expect(view.summary.subject).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('F1 — platform proposals are capped per person and AI client', () => {
  const requester = {
    organizationId: '0199aa00-0000-7000-8000-00000000c0aa',
    membershipId: 'mem-1',
    userId: 'user-1',
    clientId: 'client-1',
    clientName: 'Claude',
  };

  it(`refuses the ${PLATFORM_PROPOSALS_PER_HOUR + 1}st within the hour with 429; tenant ops are not counted`, async () => {
    const { service, repository } = serviceFor(SUSPEND);
    for (let i = 0; i < PLATFORM_PROPOSALS_PER_HOUR; i += 1) {
      await service.request(requester, 'platform.orgs.suspend', SUSPEND_ARGS, CORR);
    }
    await expect(
      service.request(requester, 'platform.orgs.suspend', SUSPEND_ARGS, CORR),
    ).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
    await service.request(requester, 'work_items.delete', { workItemId: 'wi-1' }, CORR);
    await service.request(
      { ...requester, clientId: 'client-2' },
      'platform.orgs.suspend',
      SUSPEND_ARGS,
      CORR,
    );
    expect(repository.insert).toHaveBeenCalledTimes(PLATFORM_PROPOSALS_PER_HOUR + 2);
  });
});
