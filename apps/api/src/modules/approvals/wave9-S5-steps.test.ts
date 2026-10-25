import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApprovalRow, ApprovalStepRow } from '../../common/database/schema.js';
import type { ApprovalsRepository } from './approvals.repository.js';
import type { ApprovalStepsRepository } from './steps.repository.js';
import { ApprovalStepsService } from './steps.service.js';

/**
 * Wave 9 S5 — audit run 1 F37: a chain step is decided only by its designated approver, and only
 * a `project.manage` holder defines the chain (with approvers who can approve on the project).
 */

const ORG = '0198f4a2-1c00-7000-8000-00000000000a';
const PROJECT = '0198f4a2-1c00-7000-8000-0000000000f0';
const APPROVAL = '0198f4a2-1c00-7000-8000-0000000000a1';
const M = '0198f4a2-1c00-7000-8000-000000000001'; // manager, named approver
const A = '0198f4a2-1c00-7000-8000-000000000002'; // member, attacker
const N = '0198f4a2-1c00-7000-8000-000000000003'; // another manager

const context = { organizationId: ORG, userId: M } as unknown as TenantContext;

function person(userId: string, role: Principal['role']): Principal {
  return {
    userId,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: `m-${userId}`,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

const approvalRow = {
  id: APPROVAL,
  organizationId: ORG,
  projectId: PROJECT,
} as ApprovalRow;

function build(people: Record<string, string> = { [M]: 'manager', [A]: 'member', [N]: 'manager' }) {
  const store: ApprovalStepRow[] = [];
  let seq = 0;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const approvals = {
    findById: async (_r: unknown, _c: TenantContext, id: string) =>
      id === APPROVAL ? approvalRow : null,
    internalReviewerCandidates: async (
      _r: unknown,
      _c: TenantContext,
      _p: string,
      ids: readonly string[],
    ) => ids.flatMap((userId) => (people[userId] ? [{ userId, role: people[userId] }] : [])),
  } as unknown as ApprovalsRepository;
  const steps = {
    listForApproval: async () => [...store].sort((a, b) => a.position - b.position),
    define: async (
      _r: unknown,
      _c: TenantContext,
      approvalId: string,
      input: readonly { position: number; approverRole: string; approverUserId: string | null }[],
    ) => {
      for (const step of input) {
        store.push({
          id: `step-${(seq += 1)}`,
          organizationId: ORG,
          approvalId,
          position: step.position,
          approverRole: step.approverRole,
          approverUserId: step.approverUserId,
          state: 'pending',
          decidedBy: null,
          decidedAt: null,
          createdAt: new Date(),
        });
      }
      return [...store];
    },
    decide: async (
      _r: unknown,
      _c: TenantContext,
      stepId: string,
      input: { state: ApprovalStepRow['state']; decidedBy: string },
    ) => {
      const row = store.find((s) => s.id === stepId)!;
      row.state = input.state;
      row.decidedBy = input.decidedBy;
      row.decidedAt = new Date();
      return row;
    },
  } as unknown as ApprovalStepsRepository;
  return { service: new ApprovalStepsService(database, approvals, steps), store };
}

const chain = [
  { position: 0, approverRole: 'manager', approverUserId: M },
  { position: 1, approverRole: 'manager', approverUserId: null },
];

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('F37 — approval chain steps', () => {
  it('another project member deciding the named approver’s step is refused (403), nothing written', async () => {
    const { service, store } = build();
    await service.define(context, person(M, 'manager'), APPROVAL, chain);

    const error = await refusal(
      service.decide(context, person(A, 'member'), APPROVAL, store[0]!.id, 'approve'),
    );
    expect(error.status).toBe(403);
    expect(error.auditCode).toBe('not_assigned_reviewer');
    expect(store.every((s) => s.state === 'pending' && s.decidedBy === null)).toBe(true);
  });

  it('a holder of the role is not enough when the step names a user', async () => {
    const { service, store } = build();
    await service.define(context, person(M, 'manager'), APPROVAL, chain);

    const error = await refusal(
      service.decide(context, person(N, 'manager'), APPROVAL, store[0]!.id, 'approve'),
    );
    expect(error.status).toBe(403);
    expect(store[0]!.state).toBe('pending');
  });

  it('the named approver decides; then a role-matched approver decides the role-only step', async () => {
    const { service, store } = build();
    await service.define(context, person(M, 'manager'), APPROVAL, chain);

    const first = await service.decide(
      context,
      person(M, 'manager'),
      APPROVAL,
      store[0]!.id,
      'approve',
    );
    expect(first.steps[0]).toMatchObject({ state: 'approved', decidedBy: M });

    const memberTry = await refusal(
      service.decide(context, person(A, 'member'), APPROVAL, store[1]!.id, 'approve'),
    );
    expect(memberTry.status).toBe(403);

    const second = await service.decide(
      context,
      person(N, 'manager'),
      APPROVAL,
      store[1]!.id,
      'reject',
    );
    expect(second.steps[1]).toMatchObject({ state: 'rejected', decidedBy: N });
    expect(second.activeStepId).toBeNull();
  });

  it('defining a chain needs project.manage (a member is refused, 403)', async () => {
    const { service, store } = build();
    const error = await refusal(service.define(context, person(A, 'member'), APPROVAL, chain));
    expect(error.status).toBe(403);
    expect(store).toHaveLength(0);
  });

  it('a named approver must be a project member who can approve (422)', async () => {
    const { service, store } = build({ [M]: 'manager' });
    const error = await refusal(
      service.define(context, person(M, 'manager'), APPROVAL, [
        { position: 0, approverRole: 'manager', approverUserId: A },
      ]),
    );
    expect(error.status).toBe(422);
    expect(error.auditCode).toBe('approval_step_approver_ineligible');
    expect(store).toHaveLength(0);
  });
});
