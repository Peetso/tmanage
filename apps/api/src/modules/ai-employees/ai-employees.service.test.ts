import type { Capability, Principal } from '@tmanage/domain';
import { AI_EMPLOYEE_EMAIL_DOMAIN, AI_EMPLOYEES_PER_WORKSPACE } from '@tmanage/domain';
import { describe, expect, it } from 'vitest';
import type {
  AiEmployeeHireScope,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { parseHire, parseUpdate } from './ai-employees.input.js';
import {
  AiEmployeesRepository,
  type AiEmployeeChange,
  type AiEmployeeRecord,
  type MemberFacts,
  type NewAiEmployee,
} from './ai-employees.repository.js';
import {
  AI_EMPLOYEE_AUDIT,
  AiEmployeesService,
  type AiEmployeesServiceOptions,
} from './ai-employees.service.js';

/**
 * 60-03 — the AI-employee service with an in-memory store (IP-14: fakes for ports). The SQL, the
 * organization lock, the tenant guard and the grants are proved by the DB test
 * `apps/api/test/t-60-03-ai-employees.db.test.ts` (test phase).
 */

const ORG = '00000000-0000-4000-8000-000000000001';
const OWNER_USER = '0190a000-0000-7000-8000-0000000000a1';
const OWNER_M = '0190a000-0000-7000-8000-0000000000b1';
const LEFT_M = '0190a000-0000-7000-8000-0000000000b2';
const AI_M = '0190a000-0000-7000-8000-0000000000b3';
const T0 = new Date('2026-11-21T09:00:00.000Z');

const MANAGE: readonly Capability[] = ['ai_employee.manage', 'people.view'];

function contextOf(channel = false): TenantContext {
  return {
    organizationId: ORG,
    userId: OWNER_USER,
    principalKind: 'internal',
    membershipId: OWNER_M,
    capabilities: MANAGE,
    policyVersion: '1',
    correlationId: '0190a000-0000-7000-8000-0000000000c1',
    ...(channel ? { actorChannel: 'ai_assistant' } : {}),
  } as unknown as TenantContext;
}

const OWNER: Principal = {
  userId: OWNER_USER,
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: OWNER_M,
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
} as unknown as Principal;

const RUNNER = {} as TenantQueryRunner;

class MemoryRepository extends AiEmployeesRepository {
  readonly rows = new Map<string, AiEmployeeRecord>();
  readonly members = new Map<string, MemberFacts>([
    [
      OWNER_M,
      { membershipId: OWNER_M, userId: OWNER_USER, role: 'owner', status: 'active', kind: 'human' },
    ],
    [
      LEFT_M,
      {
        membershipId: LEFT_M,
        userId: 'u-left',
        role: 'member',
        status: 'offboarded',
        kind: 'human',
      },
    ],
    [AI_M, { membershipId: AI_M, userId: 'u-ai', role: 'member', status: 'active', kind: 'ai' }],
  ]);
  locks = 0;

  override async lockOrganization(): Promise<void> {
    this.locks += 1;
  }
  override async countLive(): Promise<number> {
    return [...this.rows.values()].filter((row) => row.status !== 'retired').length;
  }
  override async liveNameTaken(
    _r: TenantQueryRunner,
    _c: TenantContext,
    name: string,
  ): Promise<boolean> {
    return [...this.rows.values()].some(
      (row) => row.status !== 'retired' && row.displayName.toLowerCase() === name.toLowerCase(),
    );
  }
  override async findMember(
    _r: TenantQueryRunner,
    _c: TenantContext,
    id: string,
  ): Promise<MemberFacts | null> {
    return this.members.get(id) ?? null;
  }
  pendingName = '';
  override async insert(
    _r: TenantQueryRunner,
    _c: TenantContext,
    row: NewAiEmployee,
  ): Promise<void> {
    this.rows.set(row.id, {
      id: row.id,
      membershipId: row.membershipId,
      userId: row.userId,
      displayName: this.pendingName,
      role: 'member',
      membershipStatus: 'active',
      sponsorMembershipId: row.sponsorMembershipId,
      sponsorDisplayName: 'Owner',
      createdByMembershipId: row.createdByMembershipId,
      jobTitle: row.jobTitle,
      departmentKey: row.departmentKey,
      vendorLabel: row.vendorLabel,
      modelLabel: row.modelLabel,
      status: 'active',
      pausedReason: null,
      pausedAt: null,
      retiredAt: null,
      timezone: row.timezone,
      workingHoursJson: row.workingHoursJson,
      limitsJson: row.limitsJson,
      discloseToClients: row.discloseToClients,
      version: 1,
      createdAt: row.at,
      updatedAt: row.at,
    });
  }
  override async list(): Promise<readonly AiEmployeeRecord[]> {
    return [...this.rows.values()];
  }
  override async findById(
    _r: TenantQueryRunner,
    _c: TenantContext,
    id: string,
  ): Promise<AiEmployeeRecord | null> {
    return this.rows.get(id) ?? null;
  }
  override async update(
    _r: TenantQueryRunner,
    _c: TenantContext,
    id: string,
    expectedVersion: number,
    change: AiEmployeeChange,
    at: Date,
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (row === undefined || row.version !== expectedVersion) return false;
    const { retiredByMembershipId: _by, ...rest } = change;
    this.rows.set(id, { ...row, ...rest, version: row.version + 1, updatedAt: at });
    return true;
  }
}

function harness(enabled = true) {
  const repository = new MemoryRepository();
  const audits: { action: string; metadata: unknown }[] = [];
  const users: { id: string; email: string; displayName: string }[] = [];
  const createdMembers: { id: string; role: string }[] = [];
  const offboarded: string[] = [];
  const scope: AiEmployeeHireScope = { identity: RUNNER, tenant: RUNNER };
  const options: AiEmployeesServiceOptions = {
    database: {
      transaction: (async (_c: TenantContext, work: (tx: TenantQueryRunner) => Promise<unknown>) =>
        work(RUNNER)) as unknown as AiEmployeesServiceOptions['database']['transaction'],
      read: (async (_c: TenantContext, work: (tx: TenantQueryRunner) => Promise<unknown>) =>
        work(RUNNER)) as unknown as AiEmployeesServiceOptions['database']['read'],
      aiEmployeeHireTransaction: (async (
        _c: TenantContext,
        work: (s: AiEmployeeHireScope) => Promise<unknown>,
      ) =>
        work(
          scope,
        )) as unknown as AiEmployeesServiceOptions['database']['aiEmployeeHireTransaction'],
    },
    audit: {
      record: (async (
        _tx: TenantQueryRunner,
        _c: TenantContext,
        input: { action: string; metadata: unknown },
      ) => {
        audits.push({ action: input.action, metadata: input.metadata });
        return {};
      }) as unknown as AiEmployeesServiceOptions['audit']['record'],
    },
    repository,
    memberships: {
      createAiMember: (async (
        _r: TenantQueryRunner,
        _c: TenantContext,
        input: { id: string; role: string },
      ) => {
        createdMembers.push({ id: input.id, role: input.role });
        return {};
      }) as unknown as AiEmployeesServiceOptions['memberships']['createAiMember'],
      requireById: (async () => ({
        status: 'active',
        version: 3,
      })) as unknown as AiEmployeesServiceOptions['memberships']['requireById'],
      transitionStatus: (async (_r: TenantQueryRunner, _c: TenantContext, id: string) => {
        offboarded.push(id);
        return {};
      }) as unknown as AiEmployeesServiceOptions['memberships']['transitionStatus'],
    },
    accounts: {
      insertUser: async (_r, user) => {
        users.push({ id: user.id, email: user.email, displayName: user.displayName });
        repository.pendingName = user.displayName;
      },
    },
    enabled,
    now: () => T0,
  };
  return {
    service: new AiEmployeesService(options),
    repository,
    audits,
    users,
    createdMembers,
    offboarded,
  };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const MAT = { displayName: 'Mat', jobTitle: 'Social media designer', vendorLabel: 'Claude' };

describe('60-03 parsing', () => {
  it('refuses hidden characters, unknown roles and limits above the cap', () => {
    const bad = parseHire({
      displayName: 'Mat‮',
      jobTitle: 'x',
      role: 'owner',
      limits: { callsPerMinute: 999 },
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues.map((issue) => issue.field).sort()).toEqual([
      'displayName',
      'limits.callsPerMinute',
      'role',
    ]);
  });

  it('defaults role member, UTC, defaults limits, disclosure on, always working', () => {
    const parsed = parseHire(MAT);
    expect(parsed).toMatchObject({
      ok: true,
      value: { role: 'member', timezone: 'UTC', workingWindows: null, discloseToClients: true },
    });
  });

  it('an update must name something and carry the version', () => {
    expect(parseUpdate({ version: 1 })).toMatchObject({ ok: false });
    expect(parseUpdate({ jobTitle: 'x' })).toMatchObject({ ok: false });
    expect(parseUpdate({ version: 2, discloseToClients: false })).toMatchObject({
      ok: true,
      value: { version: 2, discloseToClients: false },
    });
  });
});

describe('60-03 hire', () => {
  it('writes a credential-less user on .invalid, a member of kind ai and the companion row', async () => {
    const h = harness();
    const view = await h.service.hire(contextOf(), OWNER, MAT);
    expect(h.users).toHaveLength(1);
    expect(h.users[0]?.email).toBe(`ai-${h.users[0]?.id}@${AI_EMPLOYEE_EMAIL_DOMAIN}`);
    expect(h.createdMembers).toEqual([{ id: view.membershipId, role: 'member' }]);
    expect(h.repository.locks).toBe(1);
    expect(view).toMatchObject({
      displayName: 'Mat',
      status: 'active',
      sponsor: { membershipId: OWNER_M },
      vendorLabel: 'Claude',
      canPause: true,
      canResume: false,
    });
    expect(view.limits.callsPerMinute).toBe(60);
    expect(h.audits.map((a) => a.action)).toEqual([AI_EMPLOYEE_AUDIT.hired]);
  });

  it('is people only: an API key or the connector gets 403 and nothing is written', async () => {
    const h = harness();
    const error = await refusal(h.service.hire(contextOf(true), OWNER, MAT));
    expect(error.status).toBe(403);
    expect(error.auditCode).toBe('ai_employee:person_session_only');
    expect(h.users).toHaveLength(0);
    await expect(h.service.list(contextOf(true), OWNER)).rejects.toThrow(ApiError);
  });

  it('refuses an admin built-in role at the door and hires a guest', async () => {
    const h = harness();
    for (const role of ['owner', 'manager', 'workspace_admin', 'org_admin', 'platform_support']) {
      const error = await refusal(h.service.hire(contextOf(), OWNER, { ...MAT, role }));
      expect([error.status, error.code], role).toEqual([400, 'validation_failed']);
    }
    expect(h.users).toHaveLength(0);
    await h.service.hire(contextOf(), OWNER, { ...MAT, role: 'guest' });
    expect(h.createdMembers.map((member) => member.role)).toEqual(['guest']);
  });

  it('refuses a sponsor who is an AI or no longer active', async () => {
    const h = harness();
    for (const sponsor of [AI_M, LEFT_M, '0190a000-0000-7000-8000-0000000000ff']) {
      const error = await refusal(
        h.service.hire(contextOf(), OWNER, { ...MAT, sponsorMembershipId: sponsor }),
      );
      expect(error.status, sponsor).toBe(400);
    }
    expect(h.users).toHaveLength(0);
  });

  it('refuses a second live name and the hire past the beta cap', async () => {
    const h = harness();
    await h.service.hire(contextOf(), OWNER, MAT);
    const dup = await refusal(h.service.hire(contextOf(), OWNER, { ...MAT, displayName: 'MAT' }));
    expect([dup.status, dup.auditCode]).toEqual([409, 'ai_employee:name_taken']);
    for (let i = 2; i <= AI_EMPLOYEES_PER_WORKSPACE; i += 1) {
      await h.service.hire(contextOf(), OWNER, { ...MAT, displayName: `Mat ${i}` });
    }
    const cap = await refusal(
      h.service.hire(contextOf(), OWNER, { ...MAT, displayName: 'One more' }),
    );
    expect([cap.status, cap.auditCode]).toEqual([409, 'ai_employee:workspace_limit']);
  });
});

describe('60-03 lifecycle', () => {
  it('pause, stale version, resume, retire (membership offboarded), retire twice', async () => {
    const h = harness();
    const hired = await h.service.hire(contextOf(), OWNER, MAT);
    const paused = await h.service.pause(contextOf(), OWNER, hired.id, { version: 1 });
    expect(paused).toMatchObject({ status: 'paused', pausedReason: 'manual', canResume: true });
    const stale = await refusal(h.service.resume(contextOf(), OWNER, hired.id, { version: 1 }));
    expect([stale.status, stale.auditCode]).toEqual([409, 'ai_employee:stale_version']);
    const resumed = await h.service.resume(contextOf(), OWNER, hired.id, { version: 2 });
    expect(resumed.status).toBe('active');
    const retired = await h.service.retire(contextOf(), OWNER, hired.id, { version: 3 });
    expect(retired).toMatchObject({ status: 'retired', canEdit: false, canPause: false });
    expect(h.offboarded).toEqual([hired.membershipId]);
    const again = await refusal(h.service.retire(contextOf(), OWNER, hired.id, { version: 4 }));
    expect(again.status).toBe(409);
    const edit = await refusal(
      h.service.update(contextOf(), OWNER, hired.id, { version: 4, jobTitle: 'x' }),
    );
    expect(edit.auditCode).toBe('ai_employee:retired');
    expect(h.audits.map((a) => a.action)).toEqual([
      AI_EMPLOYEE_AUDIT.hired,
      AI_EMPLOYEE_AUDIT.paused,
      AI_EMPLOYEE_AUDIT.resumed,
      AI_EMPLOYEE_AUDIT.retired,
    ]);
  });

  it('will not resume while the sponsor is not an active person', async () => {
    const h = harness();
    const hired = await h.service.hire(contextOf(), OWNER, MAT);
    await h.service.pause(contextOf(), OWNER, hired.id, { version: 1 });
    h.repository.members.set(OWNER_M, {
      membershipId: OWNER_M,
      userId: OWNER_USER,
      role: 'owner',
      status: 'offboarded',
      kind: 'human',
    });
    const error = await refusal(h.service.resume(contextOf(), OWNER, hired.id, { version: 2 }));
    expect(error.auditCode).toBe('ai_employee:sponsor_not_active');
  });

  it('changes the sponsor only to an active person, audited with both ids', async () => {
    const h = harness();
    const hired = await h.service.hire(contextOf(), OWNER, MAT);
    const bad = await refusal(
      h.service.changeSponsor(contextOf(), OWNER, hired.id, {
        version: 1,
        sponsorMembershipId: AI_M,
      }),
    );
    expect(bad.status).toBe(400);
    const NEW = '0190a000-0000-7000-8000-0000000000b9';
    h.repository.members.set(NEW, {
      membershipId: NEW,
      userId: 'u-new',
      role: 'manager',
      status: 'active',
      kind: 'human',
    });
    const view = await h.service.changeSponsor(contextOf(), OWNER, hired.id, {
      version: 1,
      sponsorMembershipId: NEW,
    });
    expect(view.sponsor.membershipId).toBe(NEW);
    expect(h.audits.at(-1)).toEqual({
      action: AI_EMPLOYEE_AUDIT.sponsorChanged,
      metadata: { previous_sponsor_membership_id: OWNER_M, sponsor_membership_id: NEW },
    });
  });

  it('another workspace id is 404, never 403', async () => {
    const h = harness();
    const error = await refusal(
      h.service.get(contextOf(), OWNER, '0190a000-0000-7000-8000-00000000dead'),
    );
    expect(error.status).toBe(404);
  });

  it('edits hours in the stored time zone and refuses bad windows', async () => {
    const h = harness();
    const hired = await h.service.hire(contextOf(), OWNER, { ...MAT, timezone: 'Asia/Riyadh' });
    const bad = await refusal(
      h.service.update(contextOf(), OWNER, hired.id, {
        version: 1,
        workingHours: [{ day: 1, start: '18:00', end: '09:00' }],
      }),
    );
    expect(bad.status).toBe(400);
    const view = await h.service.update(contextOf(), OWNER, hired.id, {
      version: 1,
      workingHours: [{ day: 1, start: '09:00', end: '17:30' }],
    });
    expect(view.workingHours).toEqual([{ day: 1, start: '09:00', end: '17:30' }]);
    expect(view.timezone).toBe('Asia/Riyadh');
  });
});
