import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PendingAiActionRow } from '../../common/database/schema.js';
import { isFreshStepUp, signReauthToken } from '../identity/reauth-token.js';
import type { AiAccessSwitches } from '../oauth/ai-access.js';
import { PendingAiActionsController, parseApprovalAmount } from './pending-actions.controller.js';
import { approvalGateOf, freezeConfirmAction } from './pending-actions.js';
import { PendingAiActionsService } from './pending-actions.service.js';
import type { PendingAiActionsRepository } from './pending-actions.repository.js';

/**
 * AI panel gap 3 (Fable 5.2 ruling 2026-11-23): money and HR approvals from the member's own AI
 * keep the step-up card, and the **server** refuses an approve without it. "The screen is not the
 * control": a bare `POST …/ai/approvals/:id/approve` for a money or HR action runs nothing.
 */

const NOW = new Date('2026-11-23T10:00:00.000Z');
const SECRET = 'test-session-secret-at-least-32-characters-long';

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

function rowFor(opId: string, args: Record<string, unknown>): PendingAiActionRow {
  const frozen = freezeConfirmAction(opId, args);
  return {
    id: 'pa-1',
    organizationId: 'org-1',
    membershipId: 'mem-1',
    userId: 'user-1',
    clientId: 'client-1',
    clientName: 'ChatGPT',
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
  const execute = vi.fn(async () => ({ status: 200, body: '{}' }));
  const repository = {
    findOwn: vi.fn(async () => ({ row, memberName: 'Maya', memberEmail: 'm@x.test' })),
    decide: vi.fn(async () => 1),
    recordResult: vi.fn(async () => undefined),
  } as unknown as PendingAiActionsRepository;
  const service = new PendingAiActionsService(database, execute, repository, () => NOW);
  return { service, execute, repository };
}

// Money with an amount in its frozen arguments; HR without one; an everyday confirm-class delete.
const MONEY = rowFor('billing.credits.create', { amount: 18400, reason: 'Goodwill credit' });
const HR = rowFor('members.role.update', { userId: 'user-2', role: 'member', version: 3 });
const PLAIN = rowFor('work_items.delete', { workItemId: 'wi-1' });

describe('the approval says what it needs (AiApprovalView.confirmation)', () => {
  it('money and HR are step_up; money also names the amount; others are none', async () => {
    expect((await serviceFor(MONEY).service.view(context, 'pa-1')).confirmation).toBe('step_up');
    expect((await serviceFor(MONEY).service.view(context, 'pa-1')).amount).toBe(18400);
    expect(await serviceFor(HR).service.view(context, 'pa-1')).toMatchObject({
      confirmation: 'step_up',
      amount: null,
    });
    expect(await serviceFor(PLAIN).service.view(context, 'pa-1')).toMatchObject({
      confirmation: 'none',
      amount: null,
    });
  });

  it('decides with the in-app AI card gate, so the panel and the chat never disagree', () => {
    const frozen = freezeConfirmAction('billing.credits.create', { amount: 5, reason: 'x' });
    expect(approvalGateOf(frozen.op, frozen.args)).toEqual({ confirmation: 'step_up', amount: 5 });
  });
});

describe('the server refuses a bare approve of a money or HR action', () => {
  it('money without a step-up: 403 reauthentication_required, nothing runs', async () => {
    const { service, execute, repository } = serviceFor(MONEY);
    await expect(
      service.approveInPerson(context, 'northstar', 'pa-1', {
        stepUpFresh: false,
        amount: 18400,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'reauthentication_required' });
    expect(repository.decide).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('HR without a step-up: refused the same way', async () => {
    const { service, execute } = serviceFor(HR);
    await expect(
      service.approveInPerson(context, 'northstar', 'pa-1', {
        stepUpFresh: false,
        amount: undefined,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('money with a step-up but the wrong or missing amount: 400, nothing runs', async () => {
    const { service, execute } = serviceFor(MONEY);
    for (const amount of [18000, undefined]) {
      await expect(
        service.approveInPerson(context, 'northstar', 'pa-1', { stepUpFresh: true, amount }),
      ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs once with a fresh step-up and the amount typed back', async () => {
    const { service, execute } = serviceFor(MONEY);
    await service.approveInPerson(context, 'northstar', 'pa-1', {
      stepUpFresh: true,
      amount: 18400,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('an everyday confirm-class action still approves with one click', async () => {
    const { service, execute } = serviceFor(PLAIN);
    await service.approveInPerson(context, 'northstar', 'pa-1', {
      stepUpFresh: false,
      amount: undefined,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('the route itself: a bare POST (no x-reauth-token) is refused before anything runs', async () => {
    const { service, execute } = serviceFor(MONEY);
    const switches = { organizationOn: async () => true } as unknown as AiAccessSwitches;
    const controller = new PendingAiActionsController(service, switches, {
      sessionSecret: SECRET,
    } as never);
    await expect(
      controller.approve(context, 'northstar', 'pa-1', 'cookie', { amount: 18400 }, undefined, {
        sessionId: 'sess-1',
      } as never),
    ).rejects.toMatchObject({ status: 403, code: 'reauthentication_required' });
    expect(execute).not.toHaveBeenCalled();

    const token = signReauthToken(
      { userId: 'user-1', sessionId: 'sess-1', expiresAt: new Date(Date.now() + 60_000) },
      SECRET,
    );
    await controller.approve(context, 'northstar', 'pa-1', 'cookie', { amount: 18400 }, token, {
      sessionId: 'sess-1',
    } as never);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('the step-up decision (identity, SE-3)', () => {
  const token = (userId: string, sessionId: string, expiresAt = new Date(Date.now() + 60_000)) =>
    signReauthToken({ userId, sessionId, expiresAt }, SECRET);

  it('is fresh only for this user on this session, unexpired, with a secret', () => {
    expect(isFreshStepUp({ reauthToken: token('u', 's'), sessionId: 's' }, 'u', SECRET)).toBe(true);
    expect(isFreshStepUp({ reauthToken: token('u', 'other'), sessionId: 's' }, 'u', SECRET)).toBe(
      false,
    );
    expect(isFreshStepUp({ reauthToken: token('v', 's'), sessionId: 's' }, 'u', SECRET)).toBe(
      false,
    );
    expect(
      isFreshStepUp(
        { reauthToken: token('u', 's', new Date(Date.now() - 1)), sessionId: 's' },
        'u',
        SECRET,
      ),
    ).toBe(false);
    expect(isFreshStepUp({ reauthToken: token('u', 's'), sessionId: undefined }, 'u', SECRET)).toBe(
      false,
    );
    expect(isFreshStepUp({ reauthToken: token('u', 's'), sessionId: 's' }, 'u', undefined)).toBe(
      false,
    );
  });

  it('reads the typed amount as a number or refuses it', () => {
    expect(parseApprovalAmount({ amount: 12.5 })).toBe(12.5);
    expect(parseApprovalAmount(null)).toBeUndefined();
    expect(() => parseApprovalAmount({ amount: '18400' })).toThrow(/number/);
  });
});
