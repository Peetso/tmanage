import { capabilitiesFor, type Capability } from '@tmanage/domain';
import { describe, expect, it } from 'vitest';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { ApiError } from '../../common/http/errors.js';
import { AI_EMPLOYEE_SETTINGS_DEFAULTS } from './ai-employee-settings.repository.js';
import type { AiEmployeeRecord } from './ai-employees.repository.js';
import type { ConnectionSummary } from './connections.js';
import { AI_CONNECTOR_AUDIT, WorksAsService, worksAsOption } from './works-as.js';

/**
 * 60-07 (plan 60 v2 §4.5, §4.6; security test 9) — who may connect an app as an AI employee, with
 * fakes (IP-14). Every rule is re-checked at "Allow" inside the grant's transaction (the page's
 * list proves nothing): the server switch, a person's session, the workspace switch, the
 * workspace boundary, "the sponsor or `ai_employee.manage`", `active`, and the cap of three live
 * credentials counted over keys and connectors together. The SQL is the test phase's.
 */

const ORG = '00000000-0000-4000-8000-000000000001';
const SPONSOR_M = '0190a000-0000-7000-8000-0000000000a1';
const OTHER_M = '0190a000-0000-7000-8000-0000000000a3';
const NOBODY_M = '0190a000-0000-7000-8000-0000000000a9';
const MAT = '0190a000-0000-7000-8000-0000000000e1';
const RAMI = '0190a000-0000-7000-8000-0000000000e4';
const NOUR = '0190a000-0000-7000-8000-0000000000e7';

function record(id: string, over: Partial<AiEmployeeRecord> = {}): AiEmployeeRecord {
  return {
    id,
    membershipId: `${id.slice(0, -2)}m${id.slice(-1)}`,
    userId: `${id.slice(0, -2)}u${id.slice(-1)}`,
    displayName: id === MAT ? 'Mat' : id === RAMI ? 'Rami' : 'Nour',
    role: 'member',
    membershipStatus: 'active',
    sponsorMembershipId: SPONSOR_M,
    sponsorDisplayName: 'Peter Kamal',
    createdByMembershipId: SPONSOR_M,
    jobTitle: 'Designer',
    departmentKey: null,
    vendorLabel: null,
    modelLabel: null,
    status: 'active',
    pausedReason: null,
    pausedAt: null,
    retiredAt: null,
    timezone: 'UTC',
    workingHoursJson: null,
    limitsJson: null,
    allowedTaskTypesJson: null,
    discloseToClients: true,
    version: 1,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    ...over,
  };
}

function contextOf(
  membershipId: string,
  capabilities: readonly Capability[],
  over: Record<string, unknown> = {},
): TenantContext {
  return {
    organizationId: ORG,
    userId: 'user-x',
    membershipId,
    principalKind: 'internal',
    capabilities,
    ...over,
  } as unknown as TenantContext;
}

const SPONSOR = () => contextOf(SPONSOR_M, ['work.read', 'people.view']);
const MANAGER = () => contextOf(OTHER_M, capabilitiesFor('owner'));
const STRANGER = () => contextOf(NOBODY_M, ['work.read', 'people.view']);

function harness(
  input: {
    rows?: AiEmployeeRecord[];
    live?: number;
    enabled?: boolean;
    workspaceOn?: boolean;
  } = {},
) {
  const rows = input.rows ?? [
    record(MAT),
    record(RAMI, { status: 'paused' }),
    record(NOUR, { sponsorMembershipId: OTHER_M }),
  ];
  const audits: { action: string; objectId?: string; metadata?: unknown }[] = [];
  const locked: string[] = [];
  const service = new WorksAsService({
    database: {
      read: (async (_c: TenantContext, work: (r: TenantQueryRunner) => Promise<unknown>) =>
        work({} as TenantQueryRunner)) as never,
    },
    audit: {
      record: (async (_r: unknown, _c: unknown, event: (typeof audits)[number]) => {
        audits.push(event);
        return {};
      }) as never,
    },
    repository: {
      list: async () => rows,
      lockById: async (_r, _c, id) => {
        locked.push(id);
        return rows.some((row) => row.id === id);
      },
      findById: async (_r, _c, id) => rows.find((row) => row.id === id) ?? null,
    },
    settings: {
      read: async () => ({ ...AI_EMPLOYEE_SETTINGS_DEFAULTS, enabled: input.workspaceOn ?? true }),
    },
    summaries: async (_r, _c, ids) =>
      new Map<string, ConnectionSummary>(
        ids.map((id) => [id, { live: input.live ?? 0, lastCalledAt: null }]),
      ),
    enabled: input.enabled ?? true,
  });
  return { service, audits, locked };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('expected a refusal');
}

const tx = {} as TenantQueryRunner;

describe('worksAsOption', () => {
  it('names the first reason a row cannot be chosen', () => {
    const mat = record(MAT);
    expect(worksAsOption(mat, true, 0)).toMatchObject({ available: true, unavailableReason: null });
    expect(worksAsOption(mat, false, 0).unavailableReason).toBe('not_allowed');
    expect(worksAsOption({ ...mat, status: 'paused' }, true, 0).unavailableReason).toBe('paused');
    expect(worksAsOption(mat, true, 3).unavailableReason).toBe('limit');
  });
});

describe('WorksAsService.options (S5 list)', () => {
  it('the sponsor sees their AI employees; others dimmed as not allowed; never the retired', async () => {
    const { service } = harness({
      rows: [
        record(MAT),
        record(RAMI, { status: 'retired' }),
        record(NOUR, { sponsorMembershipId: OTHER_M }),
      ],
    });
    const view = await service.options(SPONSOR());
    expect(view.aiEmployees.map((o) => [o.displayName, o.unavailableReason])).toEqual([
      ['Mat', null],
      ['Nour', 'not_allowed'],
    ]);
  });

  it('a manager may bind every active one; the paused one shows "paused" last', async () => {
    const view = await harness().service.options(MANAGER());
    expect(view.aiEmployees.map((o) => [o.displayName, o.available])).toEqual([
      ['Mat', true],
      ['Nour', true],
      ['Rami', false],
    ]);
  });

  it('is empty for someone who may bind none, with both switches off, and for a token', async () => {
    expect((await harness().service.options(STRANGER())).aiEmployees).toEqual([]);
    expect((await harness({ enabled: false }).service.options(MANAGER())).aiEmployees).toEqual([]);
    expect((await harness({ workspaceOn: false }).service.options(MANAGER())).aiEmployees).toEqual(
      [],
    );
    const token = contextOf(OTHER_M, capabilitiesFor('owner'), { actorChannel: 'ai_assistant' });
    expect((await harness().service.options(token)).aiEmployees).toEqual([]);
  });

  it('hides the rows a person may not bind from someone without people.view', async () => {
    const view = await harness().service.options(contextOf(SPONSOR_M, ['work.read']));
    expect(view.aiEmployees.map((o) => o.displayName)).toEqual(['Mat', 'Rami']);
  });
});

describe('WorksAsService.binder (re-checked at Allow, security test 9)', () => {
  it('binds the sponsor’s active AI employee, locked first, and records the audit row', async () => {
    const { service, audits, locked } = harness();
    const target = await service.binder(MAT)(tx, SPONSOR(), 'grant-1');
    expect(target).toEqual({ membershipId: record(MAT).membershipId, userId: record(MAT).userId });
    expect(locked).toEqual([MAT]);
    expect(audits).toEqual([
      expect.objectContaining({
        action: AI_CONNECTOR_AUDIT.added,
        objectId: MAT,
        metadata: { grant_id: 'grant-1' },
      }),
    ]);
  });

  it('a sponsor can bind only their own AI employees; a manager any of the workspace', async () => {
    const stranger = await refusal(harness().service.binder(NOUR)(tx, SPONSOR(), 'g'));
    expect([stranger.status, stranger.auditCode]).toEqual([403, 'ai_employee:not_sponsor']);
    await expect(harness().service.binder(NOUR)(tx, MANAGER(), 'g')).resolves.toBeDefined();
    const nobody = await refusal(harness().service.binder(MAT)(tx, STRANGER(), 'g'));
    expect(nobody.status).toBe(403);
  });

  it('refuses paused and retired, another workspace’s id, and the cap over keys + connectors', async () => {
    const paused = await refusal(harness().service.binder(RAMI)(tx, MANAGER(), 'g'));
    expect([paused.status, paused.auditCode]).toEqual([409, 'ai_employee:paused']);
    const retired = await refusal(
      harness({ rows: [record(MAT, { status: 'retired' })] }).service.binder(MAT)(
        tx,
        MANAGER(),
        'g',
      ),
    );
    expect(retired.auditCode).toBe('ai_employee:retired');
    const foreign = await refusal(
      harness().service.binder('0190a000-0000-7000-8000-0000000000ff')(tx, MANAGER(), 'g'),
    );
    expect(foreign.status).toBe(404);
    const full = await refusal(harness({ live: 3 }).service.binder(MAT)(tx, SPONSOR(), 'g'));
    expect([full.status, full.auditCode]).toEqual([409, 'ai_employee:credential_limit']);
    await expect(
      harness({ live: 2 }).service.binder(MAT)(tx, SPONSOR(), 'g'),
    ).resolves.toBeDefined();
  });

  it('refuses with the switches off and for anything but a person’s own session', async () => {
    const off = await refusal(harness({ enabled: false }).service.binder(MAT)(tx, SPONSOR(), 'g'));
    expect([off.status, off.auditCode]).toEqual([404, 'feature.ai_employees_off']);
    const workspace = await refusal(
      harness({ workspaceOn: false }).service.binder(MAT)(tx, SPONSOR(), 'g'),
    );
    expect([workspace.status, workspace.auditCode]).toEqual([403, 'ai_employee:workspace_off']);
    for (const over of [
      { actorChannel: 'ai_assistant' },
      { principalKind: 'client' },
      { aiEmployee: { aiEmployeeId: MAT } },
    ]) {
      const refused = await refusal(
        harness().service.binder(MAT)(tx, contextOf(SPONSOR_M, ['work.read'], over), 'g'),
      );
      expect([refused.status, refused.auditCode], JSON.stringify(over)).toEqual([
        403,
        'ai_employee:person_session_only',
      ]);
    }
  });

  it('writes no audit row when it refuses', async () => {
    const { service, audits } = harness({ live: 3 });
    await refusal(service.binder(MAT)(tx, SPONSOR(), 'g'));
    expect(audits).toEqual([]);
  });
});
