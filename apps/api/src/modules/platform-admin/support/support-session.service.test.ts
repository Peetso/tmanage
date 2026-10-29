import { describe, expect, it, vi } from 'vitest';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import type { AuditService } from '../../audit/audit.service.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAuditService } from '../platform-audit.service.js';
import {
  SUPPORT_MAX_MINUTES,
  decodePreviousRole,
  encodePreviousRole,
  extendedExpiry,
  planEntry,
  planExit,
} from './hidden-membership.js';
import { SupportSessionService } from './support-session.service.js';
import type {
  SupportSessionListRecord,
  SupportSessionRecord,
  SupportSessionsRepository,
} from './support-sessions.repository.js';

/** platform-admin v2 · PA-05 — Support mode's service rules, without a database. */

const NOW = new Date('2026-10-29T10:00:00.000Z');
const ORG = '0195f3a0-0000-7000-8000-000000000001';
const ADMIN = '0195f3a0-0000-7000-8000-0000000000aa';
const SESSION = '0195f3a0-0000-7000-8000-000000000051';
const BROWSER = '0195f3a0-0000-7000-8000-0000000000b1';
const MEMBERSHIP = '0195f3a0-0000-7000-8000-0000000000c1';

function actor(stepUpSecondsLeft: number | null, userId = ADMIN): PlatformAdminActor {
  return {
    account: {
      userId,
      email: 'peter@tmanage.test',
      displayName: 'Peter',
      emailVerified: true,
      mfaEnabled: false,
    },
    sessionId: BROWSER,
    stepUp:
      stepUpSecondsLeft === null
        ? null
        : { expiresAt: new Date(NOW.getTime() + stepUpSecondsLeft * 1000), mfaVerified: false },
    permissions: ['platform.orgs.enter', 'platform.activity.view'],
  };
}

const REQUEST = {
  correlationId: '0195f3a0-0000-7000-8000-00000000c001',
  ip: '203.0.113.9',
  userAgent: 'vitest',
};

function record(overrides: Partial<SupportSessionRecord> = {}): SupportSessionListRecord {
  return {
    id: SESSION,
    adminUserId: ADMIN,
    browserSessionId: BROWSER,
    organizationId: ORG,
    membershipId: MEMBERSHIP,
    reason: null,
    startedAt: new Date(NOW.getTime() - 60 * 60_000),
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    endedAt: null,
    endedReason: null,
    actionsCount: 4,
    previousRole: null,
    previousHasOrgWideScope: null,
    organizationName: 'Northstar Studio',
    organizationSlug: 'northstar',
    adminEmail: 'peter@tmanage.test',
    now: NOW,
    ...overrides,
  };
}

function harness(
  options: {
    existing?: { id: string; role: string; status: string; hasOrgWideScope: boolean } | null;
    session?: SupportSessionListRecord;
  } = {},
) {
  const session = options.session ?? record();
  const repo = {
    lockOrganization: vi.fn(async () => ({
      id: ORG,
      slug: 'northstar',
      name: 'Northstar Studio',
      suspended: false,
    })),
    liveFor: vi.fn(async () => null),
    membershipFor: vi.fn(async () => options.existing ?? null),
    insertSession: vi.fn(async () => SESSION),
    insertHiddenMembership: vi.fn(async () => MEMBERSHIP),
    enterMembership: vi.fn(async () => undefined),
    linkSession: vi.fn(async () => undefined),
    bumpOrganization: vi.fn(async () => undefined),
    lockSession: vi.fn(async () => ({ session, now: NOW })),
    endSession: vi.fn(async () => true),
    extendSession: vi.fn(async () => undefined),
    offboardMembership: vi.fn(async () => undefined),
    restoreMembership: vi.fn(async () => undefined),
    adminEmail: vi.fn(async () => 'peter@tmanage.test'),
    recentActions: vi.fn(async () => ['work_item.created']),
    findById: vi.fn(async () => session),
    openForBrowserSession: vi.fn(async () => [{ id: SESSION, organizationId: ORG }]),
    list: vi.fn(async () => [session]),
  };
  const tx = { query: vi.fn() };
  const database = {
    transaction: vi.fn(async (_context: unknown, work: (runner: unknown) => unknown) => work(tx)),
    read: vi.fn(async (_context: unknown, work: (runner: unknown) => unknown) => work(tx)),
  };
  const platformAudit = {
    build: vi.fn((input: { action: string }) => ({ action: input.action })),
    insert: vi.fn(async () => undefined),
  };
  const orgAudit = { record: vi.fn(async () => ({})) };
  const service = new SupportSessionService(
    database as unknown as TenantDatabase,
    platformAudit as unknown as PlatformAuditService,
    () => NOW,
    repo as unknown as SupportSessionsRepository,
    orgAudit as unknown as AuditService,
  );
  return { service, repo, database, platformAudit, orgAudit };
}

describe('entering Support mode', () => {
  it('lasts 120 minutes unless the admin picks a length', async () => {
    const { service, repo } = harness();
    const view = await service.start(actor(600), ORG, {}, REQUEST);
    expect(repo.insertSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ minutes: 120 }),
    );
    expect(view).toMatchObject({ id: SESSION, slug: 'northstar', redirectTo: '/northstar/home' });
  });

  it('accepts up to 480 minutes and refuses more', async () => {
    const { service, repo } = harness();
    await service.start(actor(600), ORG, { minutes: 480 }, REQUEST);
    expect(repo.insertSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ minutes: SUPPORT_MAX_MINUTES }),
    );
    await expect(service.start(actor(600), ORG, { minutes: 481 }, REQUEST)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('refuses a step-up with under 60 seconds left (reauthentication_required)', async () => {
    const { service, repo } = harness();
    await expect(service.start(actor(59), ORG, {}, REQUEST)).rejects.toMatchObject({
      status: 403,
      code: 'reauthentication_required',
    });
    await expect(service.start(actor(null), ORG, {}, REQUEST)).rejects.toMatchObject({
      code: 'reauthentication_required',
    });
    expect(repo.insertSession).not.toHaveBeenCalled();
  });

  it('binds the session to the browser session id of the request', async () => {
    const { service, repo } = harness();
    await service.start(actor(600), ORG, { reason: 'Owner asked for help' }, REQUEST);
    expect(repo.insertSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        adminUserId: ADMIN,
        browserSessionId: BROWSER,
        reason: 'Owner asked for help',
      }),
    );
  });

  it('inserts a hidden row when the admin is not a member', async () => {
    const { service, repo } = harness();
    await service.start(actor(600), ORG, {}, REQUEST);
    expect(repo.insertHiddenMembership).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      ADMIN,
      SESSION,
    );
    expect(repo.linkSession).toHaveBeenCalledWith(
      expect.anything(),
      SESSION,
      MEMBERSHIP,
      null,
      null,
    );
  });

  it("upgrades the admin's own row and keeps its role and scope", async () => {
    const { service, repo } = harness({
      existing: { id: MEMBERSHIP, role: 'member', status: 'active', hasOrgWideScope: false },
    });
    await service.start(actor(600), ORG, {}, REQUEST);
    expect(repo.insertHiddenMembership).not.toHaveBeenCalled();
    expect(repo.enterMembership).toHaveBeenCalledWith(expect.anything(), ORG, MEMBERSHIP, SESSION);
    expect(repo.linkSession).toHaveBeenCalledWith(
      expect.anything(),
      SESSION,
      MEMBERSHIP,
      'member',
      false,
    );
  });

  it('bumps policy_version and writes both audit rows', async () => {
    const { service, repo, platformAudit, orgAudit } = harness();
    await service.start(actor(600), ORG, {}, REQUEST);
    expect(repo.bumpOrganization).toHaveBeenCalledWith(expect.anything(), ORG);
    expect(platformAudit.build).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'platform.support_session_started' }),
    );
    expect(orgAudit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: 'support.session_started',
        actorUserId: ADMIN,
        effectiveActorId: ADMIN,
      }),
    );
  });

  it('hands back the running visit instead of opening a second one', async () => {
    const { service, repo } = harness();
    repo.liveFor.mockResolvedValueOnce(record() as never);
    const view = await service.start(actor(600), ORG, {}, REQUEST);
    expect(view.id).toBe(SESSION);
    expect(repo.insertSession).not.toHaveBeenCalled();
  });
});

describe('leaving Support mode', () => {
  it('offboards the hidden row and bumps policy_version on exit', async () => {
    const { service, repo, orgAudit } = harness();
    await service.end(actor(600), SESSION, {}, REQUEST);
    expect(repo.endSession).toHaveBeenCalledWith(expect.anything(), SESSION, 'exited');
    expect(repo.offboardMembership).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      MEMBERSHIP,
      SESSION,
    );
    expect(repo.bumpOrganization).toHaveBeenCalledWith(expect.anything(), ORG);
    expect(orgAudit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'support.session_ended' }),
    );
  });

  it("restores the admin's own row on exit", async () => {
    const session = record({ previousRole: 'suspended:member', previousHasOrgWideScope: false });
    const { service, repo } = harness({ session });
    await service.end(actor(600), SESSION, {}, REQUEST);
    expect(repo.offboardMembership).not.toHaveBeenCalled();
    expect(repo.restoreMembership).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG,
      membershipId: MEMBERSHIP,
      sessionId: SESSION,
      role: 'member',
      status: 'suspended',
      hasOrgWideScope: false,
    });
  });

  it('is idempotent: a second exit changes nothing', async () => {
    const { service, repo } = harness({ session: record({ endedAt: NOW }) });
    await service.end(actor(600), SESSION, {}, REQUEST);
    expect(repo.endSession).not.toHaveBeenCalled();
  });

  it("needs a reason and orgs.lifecycle to end another admin's session", async () => {
    const other = actor(600, '0195f3a0-0000-7000-8000-0000000000bb');
    const { service } = harness();
    await expect(service.end(other, SESSION, {}, REQUEST)).rejects.toMatchObject({ status: 404 });
    const lifecycle = { ...other, permissions: ['platform.orgs.lifecycle' as const] };
    await expect(service.end(lifecycle, SESSION, {}, REQUEST)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('ends every open session of a browser session on platform sign-out', async () => {
    const { service, repo } = harness();
    const ended = await service.endForBrowserSession(
      ADMIN,
      BROWSER,
      '0195f3a0-0000-7000-8000-00000000c002',
    );
    expect(ended).toBe(1);
    expect(repo.openForBrowserSession).toHaveBeenCalledWith(
      ADMIN,
      BROWSER,
      '0195f3a0-0000-7000-8000-00000000c002',
    );
    expect(repo.endSession).toHaveBeenCalledWith(expect.anything(), SESSION, 'signed_out');
  });

  it('ends a session read from another browser session (signed out elsewhere)', async () => {
    const { service, repo } = harness();
    const view = await service.forMember(
      { id: SESSION, adminUserId: ADMIN },
      'other-browser',
      '0195f3a0-0000-7000-8000-00000000c003',
    );
    expect(view).toBeNull();
    expect(repo.endSession).toHaveBeenCalledWith(expect.anything(), SESSION, 'signed_out');
  });
});

describe('extending', () => {
  it('needs a live step-up and never passes 8 hours in total', async () => {
    const { service, repo } = harness();
    await expect(
      service.extend(actor(10), SESSION, { minutes: 30 }, REQUEST),
    ).rejects.toMatchObject({ code: 'reauthentication_required' });
    await service.extend(actor(600), SESSION, { minutes: 30 }, REQUEST);
    expect(repo.extendSession).toHaveBeenCalledWith(
      expect.anything(),
      SESSION,
      new Date(NOW.getTime() + 90 * 60_000),
    );
  });

  it('refuses at the cap', async () => {
    const session = record({
      startedAt: new Date(NOW.getTime() - 470 * 60_000),
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    });
    const { service } = harness({ session });
    await expect(
      service.extend(actor(600), SESSION, { minutes: 30 }, REQUEST),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('the hidden-membership rules', () => {
  it('plans entry from the row that is there', () => {
    expect(planEntry(null)).toEqual({ kind: 'insert' });
    expect(
      planEntry({ id: 'm', role: 'platform_support', status: 'offboarded', hasOrgWideScope: true }),
    ).toEqual({ kind: 'reactivate_hidden', membershipId: 'm' });
    expect(planEntry({ id: 'm', role: 'owner', status: 'active', hasOrgWideScope: true })).toEqual({
      kind: 'upgrade',
      membershipId: 'm',
      previousRole: 'owner',
      previousHasOrgWideScope: true,
    });
  });

  it('round-trips a non-active previous status', () => {
    expect(encodePreviousRole('member', 'offboarded')).toBe('offboarded:member');
    expect(decodePreviousRole('offboarded:member')).toEqual({
      role: 'member',
      status: 'offboarded',
    });
    expect(decodePreviousRole('org_admin')).toEqual({ role: 'org_admin', status: 'active' });
  });

  it('plans exit', () => {
    expect(
      planExit({ membershipId: null, previousRole: null, previousHasOrgWideScope: null }),
    ).toEqual({ kind: 'none' });
    expect(
      planExit({ membershipId: 'm', previousRole: null, previousHasOrgWideScope: null }),
    ).toEqual({ kind: 'offboard', membershipId: 'm' });
  });

  it('caps an extension at 8 hours after the start', () => {
    const started = new Date(NOW.getTime() - 7 * 60 * 60_000);
    const expires = new Date(NOW.getTime() + 50 * 60_000);
    expect(extendedExpiry(started, expires, NOW, 30).getTime()).toBe(
      started.getTime() + SUPPORT_MAX_MINUTES * 60_000,
    );
  });
});
