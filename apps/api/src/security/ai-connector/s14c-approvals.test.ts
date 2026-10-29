import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';
import type { PendingAiActionRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { AiPlatformSwitchGuard } from '../../modules/oauth/ai-access.js';
import { PendingAiActionsController } from '../../modules/mcp/pending-actions.controller.js';
import { PendingAiActionsRepository } from '../../modules/mcp/pending-actions.repository.js';
import { PendingAiActionsService } from '../../modules/mcp/pending-actions.service.js';
import { freezeConfirmAction } from '../../modules/mcp/pending-actions.js';

/**
 * S14C — pending AI actions (architecture F3; T-APR-02, T-APR-03). The real service over an
 * in-memory repository that applies the same guarded transition the SQL does
 * (`status = 'pending' AND expires_at > now AND` same org, membership and user), plus a check that
 * the real repository's UPDATE carries every one of those predicates.
 */

const NOW = new Date('2026-10-22T12:00:00.000Z');

const owner = {
  organizationId: 'org-1',
  userId: 'user-1',
  membershipId: 'mem-1',
  correlationId: 'corr-1',
} as unknown as TenantContext;

const database = {
  read: (_c: unknown, fn: (runner: unknown) => unknown) => fn({}),
  transaction: (_c: unknown, fn: (runner: unknown) => unknown) => fn({}),
} as unknown as TenantDatabase;

function row(overrides: Partial<PendingAiActionRow> = {}): PendingAiActionRow {
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

interface Owner {
  readonly membershipId: string;
  readonly userId: string;
}

/** An in-memory `pending_ai_actions` with the repository's exact matching rules. */
function inMemory(initial: PendingAiActionRow[]) {
  const rows = initial.map((r) => ({ ...r }));
  const mine = (context: TenantContext, who: Owner, id: string) =>
    rows.find(
      (r) =>
        r.id === id &&
        r.organizationId === context.organizationId &&
        r.membershipId === who.membershipId &&
        r.userId === who.userId,
    );
  const repository = {
    insert: async () => undefined,
    findOwn: async (_runner: unknown, context: TenantContext, who: Owner, id: string) => {
      const found = mine(context, who, id);
      return found === undefined
        ? undefined
        : { row: { ...found }, memberName: 'Maya', memberEmail: 'm@x.test' };
    },
    decide: async (
      _runner: unknown,
      context: TenantContext,
      who: Owner,
      id: string,
      status: 'approved' | 'declined',
      now: Date,
    ) => {
      const found = mine(context, who, id);
      if (!found || found.status !== 'pending' || found.expiresAt.getTime() <= now.getTime()) {
        return 0;
      }
      found.status = status;
      found.decidedAt = now;
      return 1;
    },
    recordResult: async (
      _runner: unknown,
      context: TenantContext,
      id: string,
      result: { status: number; body: unknown },
    ) => {
      const found = rows.find((r) => r.id === id && r.organizationId === context.organizationId);
      if (found && found.status === 'approved') {
        found.status = result.status >= 400 ? 'failed' : 'approved';
        found.resultStatus = result.status;
      }
    },
  } as unknown as PendingAiActionsRepository;
  const execute = vi.fn(async () => ({ status: 204, body: '' }));
  const service = new PendingAiActionsService(database, execute, repository, () => NOW);
  return { service, execute, rows };
}

/** The AI switches, with the workspace switch fixed on or off. */
function switches(organizationOn: boolean) {
  return {
    platformOn: async () => true,
    organizationOn: vi.fn(async () => organizationOn),
    forget: () => undefined,
  };
}

describe('S14C approvals — only the owning member decides', () => {
  it('another member of the same workspace gets 404 on view, approve and decline; nothing runs', async () => {
    const { service, execute, rows } = inMemory([row()]);
    const other = { ...owner, membershipId: 'mem-2', userId: 'user-2' } as TenantContext;
    await expect(service.view(other, 'pa-1')).rejects.toMatchObject({ status: 404 });
    await expect(service.approve(other, 'studio', 'pa-1')).rejects.toMatchObject({ status: 404 });
    await expect(service.decline(other, 'pa-1')).rejects.toMatchObject({ status: 404 });
    expect(execute).not.toHaveBeenCalled();
    expect(rows[0]?.status).toBe('pending');
  });

  it('the same person acting in another workspace gets 404', async () => {
    const { service, execute } = inMemory([row()]);
    const elsewhere = { ...owner, organizationId: 'org-2' } as TenantContext;
    await expect(service.approve(elsewhere, 'other', 'pa-1')).rejects.toMatchObject({
      status: 404,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('a non-cookie caller is refused by the controller before the service is reached', async () => {
    const approvals = { approve: vi.fn(), decline: vi.fn(), view: vi.fn() };
    const controller = new PendingAiActionsController(approvals as never, switches(true));
    for (const scheme of ['ai_grant', 'personal_access_token', undefined]) {
      await expect(controller.approve(owner, 'studio', 'pa-1', scheme)).rejects.toMatchObject({
        status: 403,
      });
      await expect(controller.decline(owner, 'pa-1', scheme)).rejects.toMatchObject({
        status: 403,
      });
    }
    expect(approvals.approve).not.toHaveBeenCalled();
    expect(approvals.decline).not.toHaveBeenCalled();
  });

  it('every decision route demands a capability (the guard chain runs as the member)', () => {
    const proto = PendingAiActionsController.prototype;
    for (const handler of [proto.view, proto.approve, proto.decline]) {
      // PA-01 (SPEC §3.3): the AI connector's member routes ride `ai.use`.
      expect(Reflect.getMetadata(REQUIRED_CAPABILITY, handler)).toBe('ai.use');
    }
  });
});

describe('S14C approvals — once, and never after expiry', () => {
  it('approve runs the frozen op exactly once; a second approve and a later decline change nothing', async () => {
    const { service, execute, rows } = inMemory([row()]);
    const first = await service.approve(owner, 'studio', 'pa-1');
    expect(first.status).toBe('approved');
    await service.approve(owner, 'studio', 'pa-1');
    const declined = await service.decline(owner, 'pa-1');
    expect(execute).toHaveBeenCalledOnce();
    expect(declined.status).toBe('approved');
    expect(rows[0]?.status).toBe('approved');
  });

  it('a declined action can never be approved afterwards', async () => {
    const { service, execute } = inMemory([row()]);
    await service.decline(owner, 'pa-1');
    const after = await service.approve(owner, 'studio', 'pa-1');
    expect(after.status).toBe('declined');
    expect(execute).not.toHaveBeenCalled();
  });

  it('an expired action is refused: approve runs nothing and the page reads it as expired', async () => {
    const { service, execute, rows } = inMemory([row({ expiresAt: new Date(NOW.getTime() - 1) })]);
    const result = await service.approve(owner, 'studio', 'pa-1');
    expect(result.status).toBe('expired');
    expect(execute).not.toHaveBeenCalled();
    expect(rows[0]?.status).toBe('pending');
  });

  it('an action expiring at exactly now is already expired', async () => {
    const { service, execute } = inMemory([row({ expiresAt: NOW })]);
    expect((await service.approve(owner, 'studio', 'pa-1')).status).toBe('expired');
    expect(execute).not.toHaveBeenCalled();
  });

  it('the real decide() UPDATE carries status, expiry, org, membership and user predicates', async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const runner = {
      query: async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        return { affectedRows: 0 };
      },
    } as unknown as TenantQueryRunner;
    const changed = await new PendingAiActionsRepository().decide(
      runner,
      owner,
      { membershipId: 'mem-1', userId: 'user-1' },
      'pa-1',
      'approved',
      NOW,
    );
    expect(changed).toBe(0);
    const [call] = calls;
    expect(call?.sql).toMatch(/^update `pending_ai_actions`/);
    for (const column of [
      '`organization_id` = ?',
      '`membership_id` = ?',
      '`user_id` = ?',
      '`id` = ?',
      '`status` = ?',
      '`expires_at` > ?',
    ]) {
      expect(call?.sql).toContain(column);
    }
    expect(call?.params).toEqual(expect.arrayContaining(['org-1', 'mem-1', 'user-1', 'pa-1']));
    expect(call?.params).toContain('pending');
  });
});

describe('S14C approvals — the AI kill switch', () => {
  // S14 finding, fixed (FX3): the approve page's routes, and the in-process `ai_grant` inject they
  // run the frozen op through, are behind the platform and workspace AI switches like every other
  // AI surface, so an action frozen before AI was turned off cannot be approved afterwards.
  it('approving a pending AI action is refused while AI access is off', () => {
    const guards = (Reflect.getMetadata(GUARDS_METADATA, PendingAiActionsController) ??
      []) as unknown[];
    expect(guards).toContain(AiPlatformSwitchGuard);
  });

  it('approve answers 403 while the workspace has AI apps off, and the frozen op never runs', async () => {
    const approvals = { approve: vi.fn(), decline: vi.fn(), view: vi.fn() };
    const aiAccess = switches(false);
    const controller = new PendingAiActionsController(approvals as never, aiAccess);
    await expect(controller.approve(owner, 'studio', 'pa-1', 'cookie')).rejects.toMatchObject({
      status: 403,
      auditCode: 'ai_disabled',
    });
    expect(aiAccess.organizationOn).toHaveBeenCalledWith('org-1', 'corr-1');
    expect(approvals.approve).not.toHaveBeenCalled();
  });
});
