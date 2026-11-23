import { describe, expect, it } from 'vitest';
import { isSafeAuditMetadata, type Principal } from '@tmanage/domain';
import type { WorkItemTimeLogRow } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { storedTimeTrustPolicy } from './time-trust-rules.js';
import { TimeTrustService, type TimeTrustServiceOptions } from './time-trust.service.js';

/**
 * Time you can trust (owner rule, 2026-11-23) — the policy, the approval queue, decisions,
 * corrections and history, over in-memory fakes (no database). The SQL guard (0410 trigger) and
 * the readers' `counted = 1` are proved by the migration's own checks and the readers' tests.
 */

const PA = '01890000-0000-7000-8000-00000000000a';
const PB = '01890000-0000-7000-8000-00000000000b';
const E1 = '01890000-0000-7000-8000-0000000000e1';
const E2 = '01890000-0000-7000-8000-0000000000e2';
const ctx = (membershipId: string): TenantContext =>
  ({ organizationId: 'o1', userId: `u-${membershipId}`, membershipId }) as TenantContext;
const principal = (membershipId: string, role: string, projectIds: string[] = []): Principal =>
  ({
    kind: 'internal',
    role,
    userId: `u-${membershipId}`,
    organizationId: 'o1',
    membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: role === 'owner' || role === 'org_admin',
  }) as unknown as Principal;

const lead = principal('lead', 'manager', [PA]);
const owner = principal('own', 'owner');
const admin = principal('adm', 'org_admin');
const worker = principal('m1', 'member', [PA]);

function row(o: Partial<WorkItemTimeLogRow>): WorkItemTimeLogRow {
  return {
    id: E1,
    organizationId: 'o1',
    workItemId: null,
    projectId: PA,
    loggedBy: 'm1',
    minutes: 60,
    spentOn: '2026-11-20',
    note: null,
    startedAt: null,
    endedAt: null,
    billable: true,
    source: 'manual',
    needsReview: false,
    approvalState: 'pending',
    counted: false,
    reason: 'Call on my phone',
    correctsEntryId: null,
    supersededBy: null,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: new Date('2026-11-20T10:00:00Z'),
    updatedAt: null,
    updatedBy: null,
    lockedAt: null,
    timesheetId: null,
    ...o,
  } as WorkItemTimeLogRow;
}

function harness(rows: WorkItemTimeLogRow[], stored: Record<string, string> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const settings = new Map(Object.entries(stored));
  const find = (id: string) => rows.find((r) => r.id === id) ?? null;
  const options = {
    now: () => new Date('2026-11-23T09:00:00Z'),
    database: {
      transaction: (_c: unknown, fn: (t: unknown) => unknown) => fn({}),
      read: (_c: unknown, fn: (t: unknown) => unknown) => fn({}),
    },
    repository: {
      findEntry: async (_r: unknown, _c: unknown, id: string) => find(id),
      listPending: async () => rows.filter((r) => r.approvalState === 'pending'),
      correctionsOf: async (_r: unknown, _c: unknown, id: string) =>
        rows.filter((r) => r.correctsEntryId === id),
      decide: async (_r: unknown, _c: unknown, id: string, patch: Record<string, unknown>) => {
        calls.push({ name: 'decide', args: [id, patch] });
        const target = find(id);
        if (target === null || target.approvalState !== 'pending') return 0;
        Object.assign(target, patch);
        return 1;
      },
      supersede: async (_r: unknown, _c: unknown, original: string, correction: string) => {
        calls.push({ name: 'supersede', args: [original, correction] });
        const target = find(original);
        if (target === null || target.supersededBy !== null) return 0;
        Object.assign(target, { supersededBy: correction, counted: false });
        return 1;
      },
      recountPendingHand: async (_r: unknown, _c: unknown, counted: boolean) => {
        calls.push({ name: 'recount', args: [counted] });
        return 2;
      },
    },
    sheets: {
      titles: async () => new Map<string, string>(),
      openLocks: async () => [],
    },
    timeLogs: {
      create: async (_r: unknown, _c: unknown, input: Partial<WorkItemTimeLogRow>) => {
        calls.push({ name: 'create', args: [input] });
        const created = row({ ...input, id: E2 });
        rows.push(created);
        return created;
      },
    },
    settings: {
      resolveOrganization: async () => ({ id: 'o1' }),
      findByKey: async (_r: unknown, _c: unknown, key: string) =>
        settings.has(key) ? { settingValue: settings.get(key) } : undefined,
      upsert: async (_r: unknown, _c: unknown, input: { key: string; value: string }) => {
        calls.push({ name: 'upsert', args: [input.key, input.value] });
        settings.set(input.key, input.value);
      },
    },
    audit: {
      record: async (_r: unknown, _c: unknown, event: unknown) => {
        calls.push({ name: 'audit', args: [event] });
      },
    },
  } as unknown as TimeTrustServiceOptions;
  return { service: new TimeTrustService(options), calls, rows };
}

const audits = (calls: { name: string; args: unknown[] }[]) =>
  calls.filter((c) => c.name === 'audit').map((c) => c.args[0] as Record<string, unknown>);

describe('time trust policy', () => {
  it('reads stored strings safely: anything unknown is the safe default (hand time off)', () => {
    expect(
      storedTimeTrustPolicy({ handEntry: undefined, handCount: undefined, idleCap: undefined }),
    ).toEqual({ handTimeAllowed: false, handTimeCountMode: 'after_approval', idleCapHours: 10 });
    expect(
      storedTimeTrustPolicy({ handEntry: 'yes', handCount: 'sometimes', idleCap: '99' }),
    ).toEqual({ handTimeAllowed: false, handTimeCountMode: 'after_approval', idleCapHours: 10 });
    expect(
      storedTimeTrustPolicy({ handEntry: 'true', handCount: 'at_once_flagged', idleCap: '6' }),
    ).toEqual({ handTimeAllowed: true, handTimeCountMode: 'at_once_flagged', idleCapHours: 6 });
  });

  it('lets only the company owner change it, audits every rule before and after, and recounts', async () => {
    const h = harness([]);
    await expect(
      h.service.setPolicy(ctx('adm'), admin, { handTimeAllowed: true }),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Only the company owner can change this setting.',
    });
    expect(h.calls).toEqual([]);

    const view = await h.service.setPolicy(ctx('own'), owner, {
      handTimeAllowed: true,
      handTimeCountMode: 'at_once_flagged',
    });
    expect(view).toEqual({
      handTimeAllowed: true,
      handTimeCountMode: 'at_once_flagged',
      idleCapHours: 10,
      mayChange: true,
    });
    expect(h.calls.find((c) => c.name === 'recount')?.args).toEqual([true]);
    const [event] = audits(h.calls);
    expect(event).toMatchObject({
      action: 'organization.time_trust_policy_changed',
      changes: expect.arrayContaining([
        { field: 'time_hand_entry', before: 'false', after: 'true' },
        { field: 'time_hand_count', before: 'after_approval', after: 'at_once_flagged' },
      ]),
    });
    expect(isSafeAuditMetadata(event!['metadata'])).toBe(true);
  });

  it('refuses a bad body with the field that is wrong', async () => {
    const h = harness([]);
    await expect(h.service.setPolicy(ctx('own'), owner, { idleCapHours: 2 })).rejects.toMatchObject(
      { status: 400, details: [{ field: 'idleCapHours' }] },
    );
    await expect(h.service.setPolicy(ctx('own'), owner, {})).rejects.toMatchObject({ status: 400 });
  });
});

describe('time approval queue and decisions', () => {
  it('lists only what the caller may decide: never their own, only their projects', async () => {
    const rows = [
      row({ id: E1 }),
      row({ id: E2, projectId: PB }),
      row({ id: '01890000-0000-7000-8000-0000000000e3', loggedBy: 'lead' }),
    ];
    const queue = await harness(rows).service.queue(ctx('lead'), lead);
    expect(queue.entries.map((e) => e.id)).toEqual([E1]);
    expect(queue.entries[0]).toMatchObject({ trust: 'hand', mayDecide: true, counted: false });
    expect(queue.pendingMinutes).toBe(60);
    const all = await harness(rows).service.queue(ctx('adm'), admin);
    expect(all.entries).toHaveLength(3);
  });

  it('answers 404 for one’s own entry and for another project’s, and writes nothing', async () => {
    const own = harness([row({ loggedBy: 'lead' })]);
    await expect(own.service.decide(ctx('lead'), lead, E1, {}, true)).rejects.toMatchObject({
      status: 404,
    });
    const other = harness([row({ projectId: PB })]);
    await expect(other.service.decide(ctx('lead'), lead, E1, {}, true)).rejects.toMatchObject({
      status: 404,
    });
    expect([...own.calls, ...other.calls]).toEqual([]);
  });

  it('approves: the entry counts, and the audit says who, what, before and after', async () => {
    const h = harness([row({})]);
    const view = await h.service.decide(ctx('lead'), lead, E1, {}, true);
    expect(view).toMatchObject({ approvalState: 'approved', counted: true });
    const [event] = audits(h.calls);
    expect(event).toMatchObject({
      action: 'time_log.approved',
      changes: [
        { field: 'approval_state', before: 'pending', after: 'approved' },
        { field: 'counted', before: 'false', after: 'true' },
      ],
    });
  });

  it('a refusal needs a note; refused time never counts; a second decision is 409', async () => {
    const h = harness([row({})]);
    await expect(h.service.decide(ctx('lead'), lead, E1, {}, false)).rejects.toMatchObject({
      status: 400,
      details: [{ field: 'note' }],
    });
    const view = await h.service.decide(
      ctx('lead'),
      lead,
      E1,
      { note: 'It was 30 minutes' },
      false,
    );
    expect(view).toMatchObject({ approvalState: 'rejected', counted: false });
    expect(view.decisionNote).toBe('It was 30 minutes');
    await expect(h.service.decide(ctx('lead'), lead, E1, {}, true)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('an approved correction replaces the timer entry it corrects in every total', async () => {
    const timer = row({ id: E1, source: 'timer', approvalState: 'none', counted: true });
    const fix = row({ id: E2, source: 'correction', correctsEntryId: E1, minutes: 45 });
    const h = harness([timer, fix]);
    const view = await h.service.decide(ctx('lead'), lead, E2, {}, true);
    expect(view).toMatchObject({ approvalState: 'approved', counted: true, source: 'correction' });
    expect(h.rows[0]).toMatchObject({ supersededBy: E2, counted: false });
  });

  it('a timer stopped at the cap counts only once approved', async () => {
    const capped = row({ source: 'timer', needsReview: true });
    const view = await harness([capped]).service.decide(ctx('lead'), lead, E1, {}, true);
    expect(view).toMatchObject({ approvalState: 'approved', counted: true, trust: 'measured' });
  });
});

describe('corrections of timer time', () => {
  const timer = () => row({ source: 'timer', approvalState: 'none', counted: true, reason: null });

  it('files a waiting correction with the reason; the timer entry keeps counting', async () => {
    const h = harness([timer()]);
    const view = await h.service.requestCorrection(ctx('m1'), worker, E1, {
      minutes: 45,
      reason: 'Forgot to stop it',
    });
    expect(view).toMatchObject({
      source: 'correction',
      approvalState: 'pending',
      counted: false,
      correctsEntryId: E1,
      reason: 'Forgot to stop it',
    });
    expect(h.rows[0]).toMatchObject({ counted: true, supersededBy: null });
    expect(audits(h.calls)[0]).toMatchObject({
      action: 'time_log.correction_requested',
      changes: [{ field: 'minutes', before: '60', after: '45' }],
    });
  });

  it('refuses someone else’s entry (404), hand time (409), no reason (400) and a second one (409)', async () => {
    await expect(
      harness([timer()]).service.requestCorrection(ctx('lead'), lead, E1, {
        minutes: 45,
        reason: 'Not mine',
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      harness([row({})]).service.requestCorrection(ctx('m1'), worker, E1, {
        minutes: 45,
        reason: 'Typed in',
      }),
    ).rejects.toMatchObject({ status: 409, details: [{ message: 'not_measured' }] });
    await expect(
      harness([timer()]).service.requestCorrection(ctx('m1'), worker, E1, { minutes: 45 }),
    ).rejects.toMatchObject({ status: 400, details: [{ field: 'reason' }] });
    const twice = harness([timer()]);
    await twice.service.requestCorrection(ctx('m1'), worker, E1, {
      minutes: 45,
      reason: 'One' + 'x',
    });
    await expect(
      twice.service.requestCorrection(ctx('m1'), worker, E1, { minutes: 40, reason: 'Two' + 'x' }),
    ).rejects.toMatchObject({ status: 409, details: [{ message: 'correction_pending' }] });
  });

  it('shows the history to the member and to a manager who may decide, and 404 to anyone else', async () => {
    const rows = [timer(), row({ id: E2, source: 'correction', correctsEntryId: E1 })];
    const mine = await harness(rows).service.history(ctx('m1'), worker, E1);
    expect(mine.corrections.map((c) => c.id)).toEqual([E2]);
    const managed = await harness(rows).service.history(ctx('lead'), lead, E2);
    expect(managed.original?.id).toBe(E1);
    const stranger = principal('m9', 'member', [PA]);
    await expect(harness(rows).service.history(ctx('m9'), stranger, E1)).rejects.toMatchObject({
      status: 404,
    });
  });
});
