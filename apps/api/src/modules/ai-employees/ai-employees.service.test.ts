import type { Capability, Principal } from '@tmanage/domain';
import { AI_EMPLOYEE_EMAIL_DOMAIN, AI_EMPLOYEES_PER_WORKSPACE } from '@tmanage/domain';
import { describe, expect, it } from 'vitest';
import type {
  AiEmployeeHireScope,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { AgentKeysService } from '../personal-access-tokens/agent-keys.js';
import { MemoryTokens } from '../personal-access-tokens/test-fakes.js';
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
  readonly projectIds = new Set(['0190a000-0000-7000-8000-0000000000f1']);
  readonly excluded = new Map<string, { setBy: string; at: Date }>();
  override async projectExists(
    _r: TenantQueryRunner,
    _c: TenantContext,
    id: string,
  ): Promise<boolean> {
    return this.projectIds.has(id);
  }
  override async isProjectExcluded(
    _r: TenantQueryRunner,
    _c: TenantContext,
    id: string,
  ): Promise<boolean> {
    return this.excluded.has(id);
  }
  override async excludeProject(
    _r: TenantQueryRunner,
    _c: TenantContext,
    id: string,
    setBy: string,
    at: Date,
  ): Promise<void> {
    this.excluded.set(id, { setBy, at });
  }
  override async includeProject(
    _r: TenantQueryRunner,
    _c: TenantContext,
    id: string,
  ): Promise<boolean> {
    return this.excluded.delete(id);
  }
  override async listExcludedProjects(): Promise<
    readonly { projectId: string; name: string; setByMembershipId: string; createdAt: Date }[]
  > {
    return [...this.excluded].map(([projectId, v]) => ({
      projectId,
      name: 'Launch',
      setByMembershipId: v.setBy,
      createdAt: v.at,
    }));
  }
  override async lockById(_r: TenantQueryRunner, _c: TenantContext, id: string): Promise<boolean> {
    this.locks += 1;
    return this.rows.has(id);
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
  const tokens = new MemoryTokens(T0);
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
    agentKeys: new AgentKeysService(tokens),
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
    tokens,
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

describe('60-05 agent keys', () => {
  const KEY = { name: 'Mat on Claude', lifetimeDays: 30 };
  const SPONSOR_ONLY = (): TenantContext =>
    ({ ...contextOf(), capabilities: ['people.view'] }) as unknown as TenantContext;
  const STRANGER = (): TenantContext =>
    ({
      ...contextOf(),
      membershipId: LEFT_M,
      capabilities: ['people.view'],
    }) as unknown as TenantContext;

  it('makes keys on the AI membership, shows each once, caps live keys at 3, audited', async () => {
    const h = harness();
    const hired = await h.service.hire(contextOf(), OWNER, MAT);
    const first = await h.service.createKey(contextOf(), OWNER, hired.id, KEY);
    expect(first.token).toMatch(/^tmanage_pat_/);
    expect(h.tokens.rows[0]).toMatchObject({
      membershipId: hired.membershipId,
      scopes: 'tmanage:agent',
      createdByMembershipId: OWNER_M,
    });
    await h.service.createKey(contextOf(), OWNER, hired.id, KEY);
    await h.service.createKey(contextOf(), OWNER, hired.id, KEY);
    const fourth = await refusal(h.service.createKey(contextOf(), OWNER, hired.id, KEY));
    expect([fourth.status, fourth.auditCode]).toEqual([409, 'ai_employee:credential_limit']);
    const listed = await h.service.listKeys(contextOf(), OWNER, hired.id);
    expect(listed).toMatchObject({ limit: 3, live: 3, canCreate: false });
    expect(JSON.stringify(listed)).not.toContain(first.token);
    expect(h.audits.filter((a) => a.action === AI_EMPLOYEE_AUDIT.keyCreated)).toHaveLength(3);
  });

  it('the sponsor may bind without the manage capability; anyone else may not', async () => {
    const h = harness();
    const hired = await h.service.hire(contextOf(), OWNER, MAT);
    await expect(h.service.createKey(SPONSOR_ONLY(), OWNER, hired.id, KEY)).resolves.toMatchObject({
      live: true,
    });
    for (const call of [
      h.service.listKeys(STRANGER(), OWNER, hired.id),
      h.service.createKey(STRANGER(), OWNER, hired.id, KEY),
    ]) {
      const error = await refusal(call);
      expect([error.status, error.auditCode]).toEqual([403, 'ai_employee:not_sponsor']);
    }
  });

  it('rotation replaces a live key inside the cap and ends the old one within 24 hours', async () => {
    const h = harness();
    const hired = await h.service.hire(contextOf(), OWNER, MAT);
    const keys: { id: string }[] = [];
    for (let i = 0; i < 3; i += 1)
      keys.push(await h.service.createKey(contextOf(), OWNER, hired.id, KEY));
    const rotated = await h.service.rotateKey(contextOf(), OWNER, hired.id, keys[0]!.id, KEY);
    expect(rotated.id).not.toBe(keys[0]!.id);
    const old = h.tokens.rows.find((row) => row.id === keys[0]!.id);
    expect(old?.expiresAt?.getTime()).toBe(T0.getTime() + 24 * 60 * 60 * 1000);
    const missing = await refusal(h.service.rotateKey(contextOf(), OWNER, hired.id, 'k-none', KEY));
    expect(missing.auditCode).toBe('ai_employee:key_not_found');
    expect(h.audits.at(-1)).toMatchObject({
      action: AI_EMPLOYEE_AUDIT.keyRotated,
      metadata: { replaced_key_id: keys[0]!.id },
    });
  });

  it('revokes at once, also after retirement; a retired AI employee gets no new key', async () => {
    const h = harness();
    const hired = await h.service.hire(contextOf(), OWNER, MAT);
    const key = await h.service.createKey(contextOf(), OWNER, hired.id, KEY);
    await h.service.retire(contextOf(), OWNER, hired.id, { version: 1 });
    const blocked = await refusal(h.service.createKey(contextOf(), OWNER, hired.id, KEY));
    expect(blocked.auditCode).toBe('ai_employee:retired');
    await h.service.revokeKey(contextOf(), OWNER, hired.id, key.id);
    expect(h.tokens.rows[0]?.revokedAt).toEqual(T0);
    const twice = await refusal(h.service.revokeKey(contextOf(), OWNER, hired.id, key.id));
    expect(twice.auditCode).toBe('ai_employee:key_not_found');
    expect(h.audits.at(-1)?.action).toBe(AI_EMPLOYEE_AUDIT.keyRevoked);
  });

  it('refuses a bad body before any write, and an AI-assistant channel entirely', async () => {
    const h = harness();
    const hired = await h.service.hire(contextOf(), OWNER, MAT);
    const bad = await refusal(
      h.service.createKey(contextOf(), OWNER, hired.id, { name: 'x', lifetimeDays: 365 }),
    );
    expect(bad.status).toBe(400);
    const channel = await refusal(h.service.createKey(contextOf(true), OWNER, hired.id, KEY));
    expect(channel.status).toBe(403);
    expect(h.tokens.rows).toHaveLength(0);
  });
});

describe('project exclusion (plan 60 v2 M5)', () => {
  const PROJECT = '0190a000-0000-7000-8000-0000000000f1';

  it('excludes once (idempotent, one audit row), lists, includes again, audited', async () => {
    const h = harness();
    const first = await h.service.excludeProject(contextOf(), OWNER, PROJECT.toUpperCase());
    expect(first.projects).toEqual([
      {
        projectId: PROJECT,
        name: 'Launch',
        setByMembershipId: OWNER_M,
        createdAt: T0.toISOString(),
      },
    ]);
    await h.service.excludeProject(contextOf(), OWNER, PROJECT);
    expect(h.repository.excluded.size).toBe(1);
    expect(h.audits.filter((a) => a.action === AI_EMPLOYEE_AUDIT.projectExcluded)).toHaveLength(1);
    expect(h.repository.locks).toBeGreaterThan(0);
    const listed = await h.service.listExcludedProjects(contextOf(), OWNER);
    expect(listed.canEdit).toBe(true);
    await h.service.includeProject(contextOf(), OWNER, PROJECT);
    expect(h.repository.excluded.size).toBe(0);
    expect(h.audits.at(-1)?.action).toBe(AI_EMPLOYEE_AUDIT.projectIncluded);
  });

  it('refuses an unknown or other-workspace project, a project not excluded, and an AI channel', async () => {
    const h = harness();
    const unknown = await refusal(
      h.service.excludeProject(contextOf(), OWNER, '0190a000-0000-7000-8000-0000000000f9'),
    );
    expect([unknown.status, unknown.auditCode]).toEqual([404, 'ai_employee:project_not_found']);
    const notExcluded = await refusal(h.service.includeProject(contextOf(), OWNER, PROJECT));
    expect(notExcluded.auditCode).toBe('ai_employee:project_not_excluded');
    const channel = await refusal(h.service.excludeProject(contextOf(true), OWNER, PROJECT));
    expect(channel.status).toBe(403);
    expect(h.repository.excluded.size).toBe(0);
  });
});
