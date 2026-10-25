import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApprovalStepsController } from './steps.controller.js';
import { ApprovalStepsService } from './steps.service.js';
import type { ApprovalsRepository } from './approvals.repository.js';
import type { ApprovalStepsRepository } from './steps.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApprovalRow, ApprovalStepRow } from '../../common/database/schema.js';

/**
 * Sequential approval-step (x315) proofs, database-free over fakes with the *real* `authorize` and the
 * *real* service. The migration and the tenant-scoped SQL round-trip are the chain's DB suite, not
 * here; this file proves the controller/service security logic — resolve-before-authorize
 * (cross-tenant/unknown approval id → 404 with no write), the `approval.decide` capability decision
 * (403 with no write), the body validation (empty/duplicate position → 400 with no write), and the
 * chain ordering (deciding a non-active step → 409 with no write) — plus the succeeded define/decide
 * writing exactly the chain.
 */

const ORG = '0198f4a2-1c00-7000-8000-00000000000a';
const OTHER_ORG = '0198f4a2-1c00-7000-8000-00000000000b';
const USER = '0198f4a2-1c00-7000-8000-000000000001';
const PROJECT = '0198f4a2-1c00-7000-8000-0000000000f0';
const APPROVAL = '0198f4a2-1c00-7000-8000-0000000000a1';

function principal(role: Principal['role'], overrides: Partial<Principal> = {}): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: role.startsWith('client_') ? 'client' : 'internal',
    role,
    membershipId: '0198f4a2-1c00-7000-8000-000000000010',
    membershipStatus: 'active',
    clientOrganizationId: role.startsWith('client_') ? ORG : null,
    projectIds: [],
    hasOrgWideScope: role === 'owner',
    ...overrides,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function approval(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: APPROVAL,
    organizationId: ORG,
    projectId: PROJECT,
    deliverableId: 'd1',
    deliverableVersionId: 'v1',
    contentHash: 'h',
    state: 'requested',
    policy: 'ordered_sequence',
    reviewerIds: [],
    decidedByUserId: null,
    decidedAt: null,
    feedback: null,
    invalidationReason: null,
    version: 1,
    createdAt: new Date('2026-09-27T10:00:00.000Z'),
    updatedAt: new Date('2026-09-27T10:00:00.000Z'),
    ...overrides,
  } as ApprovalRow;
}

function controllerWith(approvals: readonly ApprovalRow[]) {
  const store: ApprovalStepRow[] = [];
  let seq = 0;

  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const approvalsRepository = {
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      approvals.find((row) => row.organizationId === ctx.organizationId && row.id === id) ?? null,
  } as unknown as ApprovalsRepository;

  const stepsRepository = {
    listForApproval: async (_runner: unknown, ctx: TenantContext, approvalId: string) =>
      store
        .filter((r) => r.organizationId === ctx.organizationId && r.approvalId === approvalId)
        .sort((a, b) => a.position - b.position),
    define: async (
      _runner: unknown,
      ctx: TenantContext,
      approvalId: string,
      steps: readonly { position: number; approverRole: string; approverUserId: string | null }[],
    ) => {
      for (const step of steps) {
        store.push({
          id: `step-${(seq += 1).toString().padStart(2, '0')}`,
          organizationId: ctx.organizationId,
          approvalId,
          position: step.position,
          approverRole: step.approverRole,
          approverUserId: step.approverUserId,
          state: 'pending',
          decidedBy: null,
          decidedAt: null,
          createdAt: new Date('2026-09-27T11:00:00.000Z'),
        });
      }
      return store
        .filter((r) => r.approvalId === approvalId)
        .sort((a, b) => a.position - b.position);
    },
    decide: async (
      _runner: unknown,
      _ctx: TenantContext,
      stepId: string,
      input: { state: ApprovalStepRow['state']; decidedBy: string },
    ) => {
      const row = store.find((r) => r.id === stepId);
      if (!row) throw new Error('missing');
      row.state = input.state;
      row.decidedBy = input.decidedBy;
      row.decidedAt = new Date('2026-09-27T12:00:00.000Z');
      return row;
    },
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      store.find((r) => r.organizationId === ctx.organizationId && r.id === id) ?? null,
  } as unknown as ApprovalStepsRepository;

  const service = new ApprovalStepsService(database, approvalsRepository, stepsRepository);
  return { controller: new ApprovalStepsController(service), store };
}

const owner = () => principal('owner');

const twoSteps = {
  steps: [
    { position: 0, approverRole: 'manager' },
    { position: 1, approverRole: 'owner' },
  ],
};

describe('ApprovalStepsController', () => {
  it('defines an ordered chain and reads it back with the active step', async () => {
    const { controller, store } = controllerWith([approval()]);
    const view = await controller.define(context, owner(), APPROVAL, twoSteps);

    expect(view.steps.map((s) => s.position)).toEqual([0, 1]);
    expect(view.steps.every((s) => s.state === 'pending')).toBe(true);
    expect(view.activeStepId).toBe(view.steps[0]!.id);
    expect(view.steps[0]).not.toHaveProperty('organizationId');
    expect(store).toHaveLength(2);
  });

  it('refuses define without approval.decide with 403 and writes nothing', async () => {
    // client_viewer holds approval.read but not approval.decide, so the capability gate denies it.
    const { controller, store } = controllerWith([approval()]);
    await expect(
      controller.define(context, principal('client_viewer'), APPROVAL, twoSteps),
    ).rejects.toMatchObject({ status: 403 });
    expect(store).toHaveLength(0);
  });

  it('rejects an empty or duplicate-position body with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith([approval()]);
    await expect(
      controller.define(context, owner(), APPROVAL, { steps: [] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.define(context, owner(), APPROVAL, {
        steps: [
          { position: 0, approverRole: 'manager' },
          { position: 0, approverRole: 'owner' },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, auditCode: 'approval_step_duplicate_position' });
    expect(store).toHaveLength(0);
  });

  it('returns 404 with no write for a cross-tenant approval id on decide', async () => {
    // The approval exists only in another tenant; resolve-before-authorize makes it a 404, not a 403.
    const { controller, store } = controllerWith([
      approval({ id: APPROVAL, organizationId: OTHER_ORG }),
    ]);
    await expect(
      controller.decide(context, owner(), APPROVAL, 'step-01', { decision: 'approve' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store).toHaveLength(0);
  });

  it('refuses an out-of-order decision with 409 and leaves the chain unchanged', async () => {
    const { controller, store } = controllerWith([approval()]);
    await controller.define(context, owner(), APPROVAL, twoSteps);
    const second = store.find((s) => s.position === 1)!;

    await expect(
      controller.decide(context, owner(), APPROVAL, second.id, { decision: 'approve' }),
    ).rejects.toMatchObject({ status: 409, auditCode: 'approval_step_out_of_order' });
    expect(store.every((s) => s.state === 'pending')).toBe(true);
  });

  it('advances the active step and moves the active pointer forward', async () => {
    const { controller } = controllerWith([approval()]);
    const defined = await controller.define(context, owner(), APPROVAL, twoSteps);
    const first = defined.steps[0]!;

    // Step 0 names the `manager` role (F37: only its designated approver decides it).
    const manager = principal('manager', { projectIds: [PROJECT] });
    const after = await controller.decide(context, manager, APPROVAL, first.id, {
      decision: 'approve',
    });
    expect(after.steps[0]!.state).toBe('approved');
    expect(after.activeStepId).toBe(after.steps[1]!.id);
  });
});
