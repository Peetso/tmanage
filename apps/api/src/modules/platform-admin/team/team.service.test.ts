import { describe, expect, it, vi } from 'vitest';
import { PLATFORM_PERMISSIONS, PLATFORM_PRESETS } from '@tmanage/domain';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAuditInput } from '../platform-admin.repository.js';
import type {
  PlatformAdminRecord,
  PlatformTeamRow,
  PlatformUserRow,
} from '../platform-admins.repository.js';
import { PlatformTeamService } from './team.service.js';
import type { TeamStore } from './team.service.js';

/** The team rules hold in the service, not only on the screen. */

const ME = '0199aa00-0000-7000-8000-0000000000a1';
const SARA = '0199aa00-0000-7000-8000-0000000000a2';
const OMAR = '0199aa00-0000-7000-8000-0000000000a3';
const ENV_USER = '0199aa00-0000-7000-8000-0000000000a4';
const ROW_SARA = '0199aa00-0000-7000-8000-0000000000b2';
const ROW_ME = '0199aa00-0000-7000-8000-0000000000b1';
const ROW_ENV = '0199aa00-0000-7000-8000-0000000000b4';
const REASON = 'Joining the support rota';
const ctx = { correlationId: 'c', ip: '203.0.113.1', userAgent: 'Edge' };

const actor: PlatformAdminActor = {
  account: {
    userId: ME,
    email: 'me@tmanage.test',
    displayName: 'Me',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 's',
  stepUp: null,
  source: 'db',
  preset: 'super_admin',
  permissions: [...PLATFORM_PERMISSIONS],
};

function user(userId: string, email: string, verified = true): PlatformUserRow {
  return {
    userId,
    email,
    displayName: email.split('@')[0] ?? email,
    emailVerified: verified,
    verifiedAt: verified ? new Date() : null,
    lastStepUpAt: null,
  };
}

const USERS = [
  user(ME, 'me@tmanage.test'),
  user(SARA, 'sara@tmanage.test'),
  user(OMAR, 'omar@tmanage.test'),
  user(ENV_USER, 'peter@tmanage.test'),
  user('0199aa00-0000-7000-8000-0000000000a9', 'new@tmanage.test', false),
];

function teamRow(
  id: string,
  userId: string,
  preset: PlatformAdminRecord['preset'],
): PlatformTeamRow {
  const email = USERS.find((u) => u.userId === userId)?.email ?? 'x@x.test';
  return {
    id,
    userId,
    preset,
    customPermissions: null,
    permissions:
      preset === 'super_admin' ? [...PLATFORM_PERMISSIONS] : [...PLATFORM_PRESETS.support],
    status: 'active',
    email,
    displayName: email,
    createdBy: null,
    createdByEmail: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    disabledAt: null,
    disabledReason: null,
    lastStepUpAt: null,
  };
}

function harness(o: { allowlist?: string[]; rows?: PlatformTeamRow[] } = {}) {
  const rows = o.rows ?? [
    teamRow(ROW_ME, ME, 'super_admin'),
    teamRow(ROW_SARA, SARA, 'super_admin'),
  ];
  const audits: PlatformAuditInput[] = [];
  const store = {
    listTeam: async () => rows,
    findById: async (id: string) => rows.find((r) => r.id === id) ?? null,
    findUserByEmail: async (email: string) => USERS.find((u) => u.email === email) ?? null,
    findUserById: async (id: string) => USERS.find((u) => u.userId === id) ?? null,
    findUsersByEmails: async (emails: readonly string[]) =>
      USERS.filter((u) => emails.includes(u.email)),
    insert: vi.fn(async (_input: unknown, audit: PlatformAuditInput) => {
      audits.push(audit);
      rows.push(teamRow('0199aa00-0000-7000-8000-0000000000b3', OMAR, 'support'));
      return '0199aa00-0000-7000-8000-0000000000b3';
    }),
    update: vi.fn(async (_id: string, _input: unknown, audit: PlatformAuditInput) => {
      audits.push(audit);
    }),
    writePreset: vi.fn(async (_p: string, _l: unknown, audit: PlatformAuditInput) => {
      audits.push(audit);
    }),
    storedPresets: async () => ({}),
  } satisfies TeamStore;
  const service = new PlatformTeamService(store, o.allowlist ?? []);
  return { service, store, audits };
}

describe('PlatformTeamService', () => {
  it('lists server-list admins first as locked super admins, and marks the viewer’s own row', async () => {
    const { service } = harness({ allowlist: ['peter@tmanage.test'] });
    const view = await service.list(actor, ctx);
    expect(view.admins.map((a) => [a.email, a.source, a.locked, a.self, a.preset])).toEqual([
      ['peter@tmanage.test', 'env', true, false, 'super_admin'],
      ['me@tmanage.test', 'db', false, true, 'super_admin'],
      ['sara@tmanage.test', 'db', false, false, 'super_admin'],
    ]);
    expect(view).toMatchObject({ superAdmins: 3, envSuperAdmins: 1, canManage: true });
  });

  it('adds a verified account with its preset, the reason and an audit row', async () => {
    const { service, store, audits } = harness();
    const { admin } = await service.add(
      actor,
      { email: 'OMAR@tmanage.test', preset: 'support', reason: REASON },
      ctx,
    );
    expect(admin).toMatchObject({ email: 'omar@tmanage.test', preset: 'support', source: 'db' });
    expect(store.insert).toHaveBeenCalledWith(
      { userId: OMAR, preset: 'support', customPermissions: null, createdBy: ME },
      expect.anything(),
    );
    expect(audits[0]).toMatchObject({
      action: 'platform.team_admin_added',
      reason: REASON,
      ip: '203.0.113.1',
      targetLabel: 'omar@tmanage.test',
    });
  });

  it('requires a reason for every team change and writes nothing without one', async () => {
    const { service, store } = harness();
    await expect(
      service.add(actor, { email: 'omar@tmanage.test', preset: 'support' }, ctx),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.update(actor, ROW_SARA, { status: 'disabled' }, ctx),
    ).rejects.toMatchObject({ status: 400 });
    await expect(service.remove(actor, ROW_SARA, { reason: 'no' }, ctx)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.writePreset(actor, 'support', { permissions: [] }, ctx),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.insert).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    expect(store.writePreset).not.toHaveBeenCalled();
  });

  it('refuses an unverified or unknown account', async () => {
    const { service } = harness();
    await expect(
      service.add(actor, { email: 'new@tmanage.test', preset: 'support', reason: REASON }, ctx),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.add(actor, { email: 'ghost@tmanage.test', preset: 'support', reason: REASON }, ctx),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to edit one’s own row', async () => {
    const { service, store } = harness();
    await expect(
      service.update(actor, ROW_ME, { preset: 'auditor', reason: REASON }, ctx),
    ).rejects.toMatchObject({ status: 409 });
    expect(store.update).not.toHaveBeenCalled();
  });

  it('keeps server-list admins locked: never added, edited or removed here', async () => {
    const rows = [teamRow(ROW_ME, ME, 'super_admin'), teamRow(ROW_ENV, ENV_USER, 'support')];
    const { service, store } = harness({ allowlist: ['peter@tmanage.test'], rows });
    await expect(
      service.add(actor, { email: 'peter@tmanage.test', preset: 'support', reason: REASON }, ctx),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.update(actor, ROW_ENV, { status: 'disabled', reason: REASON }, ctx),
    ).rejects.toMatchObject({ status: 409 });
    expect(store.update).not.toHaveBeenCalled();
  });

  it('keeps one super admin: the last one cannot be disabled, but the server list counts', async () => {
    const onlySara = [teamRow(ROW_ME, ME, 'support'), teamRow(ROW_SARA, SARA, 'super_admin')];
    const lonely = harness({ rows: onlySara.map((r) => ({ ...r })) });
    await expect(
      lonely.service.update(actor, ROW_SARA, { status: 'disabled', reason: REASON }, ctx),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      lonely.service.update(actor, ROW_SARA, { preset: 'auditor', reason: REASON }, ctx),
    ).rejects.toMatchObject({ status: 409 });

    const withEnv = harness({
      allowlist: ['peter@tmanage.test'],
      rows: onlySara.map((r) => ({ ...r })),
    });
    await withEnv.service.update(actor, ROW_SARA, { status: 'disabled', reason: REASON }, ctx);
    expect(withEnv.audits[0]).toMatchObject({
      action: 'platform.team_admin_disabled',
      targetId: ROW_SARA,
      reason: REASON,
    });
    expect(withEnv.store.update).toHaveBeenCalledWith(
      ROW_SARA,
      {
        preset: 'super_admin',
        customPermissions: null,
        status: 'disabled',
        disabledReason: REASON,
      },
      expect.anything(),
    );
  });

  it('removes by disabling, with its own action name', async () => {
    const { service, audits, store } = harness();
    await service.remove(actor, ROW_SARA, { reason: REASON }, ctx);
    expect(audits[0]?.action).toBe('platform.team_admin_removed');
    expect(store.update).toHaveBeenCalledWith(
      ROW_SARA,
      expect.objectContaining({ status: 'disabled' }),
      expect.anything(),
    );
  });

  it('never lets a custom list or a preset carry platform.team.manage', async () => {
    const { service, store } = harness();
    await service.update(
      actor,
      ROW_SARA,
      {
        preset: 'custom',
        permissions: ['platform.team.manage', 'platform.orgs.view'],
        reason: REASON,
      },
      ctx,
    );
    expect(store.update).toHaveBeenCalledWith(
      ROW_SARA,
      expect.objectContaining({ preset: 'custom', customPermissions: ['platform.orgs.view'] }),
      expect.anything(),
    );
    await service.writePreset(
      actor,
      'support',
      { permissions: ['platform.team.manage', 'platform.activity.export'], reason: REASON },
      ctx,
    );
    expect(store.writePreset).toHaveBeenCalledWith(
      'support',
      ['platform.activity.export'],
      expect.anything(),
    );
  });

  it('keeps super admin fixed and refuses an unknown preset or key', async () => {
    const { service } = harness();
    await expect(
      service.writePreset(actor, 'super_admin', { permissions: [], reason: REASON }, ctx),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.writePreset(
        actor,
        'support',
        { permissions: ['platform.nope'], reason: REASON },
        ctx,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.add(actor, { email: 'omar@tmanage.test', preset: 'owner', reason: REASON }, ctx),
    ).rejects.toMatchObject({ status: 400 });
  });
});
