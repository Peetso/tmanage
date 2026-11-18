import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PendingAiActionRow } from '../../common/database/schema.js';
import { freezeConfirmAction } from './pending-actions.js';
import { PENDING_LIST_LIMIT, PendingAiActionsService } from './pending-actions.service.js';
import type { PendingAiActionsRepository } from './pending-actions.repository.js';

/** 55-15p: the member's own waiting actions, for the "AI actions" list and badge. */

const NOW = new Date('2026-11-18T10:00:00.000Z');

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

function row(id: string, overrides: Partial<PendingAiActionRow> = {}): PendingAiActionRow {
  const frozen = freezeConfirmAction('work_items.delete', { workItemId: `wi_${id}` });
  return {
    id,
    organizationId: 'org-1',
    membershipId: 'mem-1',
    userId: 'user-1',
    clientId: 'oauth:1',
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

function serviceWith(rows: PendingAiActionRow[]) {
  const execute = vi.fn(async () => ({ status: 200, body: '' }));
  const listOwnPending = vi.fn(async () =>
    rows.map((r) => ({ row: r, memberName: 'Maya Hassan', memberEmail: 'm@x.test' })),
  );
  const repository = { listOwnPending } as unknown as PendingAiActionsRepository;
  const service = new PendingAiActionsService(database, execute, repository, () => NOW);
  return { service, execute, listOwnPending };
}

describe('listing waiting AI actions (55-15p)', () => {
  it("asks for the member's own pending rows only, and runs nothing", async () => {
    const { service, execute, listOwnPending } = serviceWith([row('pa-1'), row('pa-2')]);
    const { items } = await service.listPending(context);

    expect(items.map((item) => item.id)).toEqual(['pa-1', 'pa-2']);
    expect(items[0]).toMatchObject({ status: 'pending', clientName: 'Claude' });
    expect(items[0]?.summary.title).toBeTruthy();
    expect(listOwnPending).toHaveBeenCalledWith(
      {},
      context,
      { membershipId: 'mem-1', userId: 'user-1' },
      NOW,
      PENDING_LIST_LIMIT,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('names each row by reading its target, never by running the action (TESTUX P1 9)', async () => {
    const { service, execute } = serviceWith([row('pa-1')]);
    execute.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ title: 'Prepare mobile booking flow concepts' }),
    });
    const { items } = await service.listPending(context, 'northstar');

    expect(items[0]?.summary.subject).toBe('Prepare mobile booking flow concepts');
    expect(execute).toHaveBeenCalledTimes(1);
    const [request, grant] = execute.mock.calls[0] as unknown as [
      { method: string },
      { opId: string },
    ];
    expect(request.method).toBe('GET');
    expect(grant.opId).toBe('work_items.get');
  });

  it('leaves out a row whose stored arguments no longer verify', async () => {
    const { service } = serviceWith([row('pa-1'), row('pa-x', { argsSha256: 'tampered' })]);
    const { items } = await service.listPending(context);
    expect(items.map((item) => item.id)).toEqual(['pa-1']);
  });
});
