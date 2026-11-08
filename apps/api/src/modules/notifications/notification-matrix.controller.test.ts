import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { NaturalNotificationKind, Principal, StoredMatrix } from '@tmanage/domain';
import { NotificationMatrixController } from './notification-matrix.controller.js';
import type { NotificationMatrixRepository } from './notification-matrix.repository.js';
import type { NotificationKindPrefsRepository } from './notification-kind-prefs.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { defaultFor, validateValue } from '../tenancy/org-settings.allowlist.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const ME = '00000000-0000-4000-8000-0000000000e1';

function principal(role: Principal['role']): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: ME,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
  } as Principal;
}

const context = { organizationId: ORG, membershipId: ME } as unknown as TenantContext;

function fixture(forced: NaturalNotificationKind[] = []) {
  const kindRows: { membershipId: string; kind: string; enabled: boolean }[] = [];
  const stored: Record<string, Record<string, boolean>> = {};
  const writes: string[] = [];
  const kinds = {
    listForMembership: (_r: unknown, _c: unknown, membershipId: string) =>
      Promise.resolve(kindRows.filter((row) => row.membershipId === membershipId)),
    findNotificationProfile: () => Promise.resolve('calm' as const),
    upsert: (_r: unknown, _c: unknown, membershipId: string, kind: string, enabled: boolean) => {
      writes.push(`kind:${membershipId}:${kind}:${String(enabled)}`);
      kindRows.push({ membershipId, kind, enabled });
      return Promise.resolve();
    },
  } as unknown as NotificationKindPrefsRepository;
  const matrix = {
    readStoredMatrix: () => Promise.resolve(stored as StoredMatrix),
    readForcedEmailKinds: () => Promise.resolve(forced),
    writeCell: (
      _r: unknown,
      _c: unknown,
      membershipId: string,
      kind: string,
      channel: string,
      enabled: boolean,
    ) => {
      writes.push(`cell:${membershipId}:${kind}:${channel}:${String(enabled)}`);
      stored[kind] = { ...stored[kind], [channel]: enabled };
      return Promise.resolve();
    },
  } as unknown as NotificationMatrixRepository;
  const database = {
    read: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
    transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
  } as unknown as TenantDatabase;
  return { controller: new NotificationMatrixController(database, matrix, kinds), writes };
}

describe('NotificationMatrixController (53-15)', () => {
  it('lists every kind with calm defaults, the locked account row and the manage flag', async () => {
    const { controller } = fixture();
    const view = await controller.get(context, principal('owner'));
    expect(view.rows.map((row) => row.kind)).toEqual([
      'client_request',
      'work_item',
      'message',
      'file',
      'mention',
    ]);
    const file = view.rows.find((row) => row.kind === 'file')!;
    expect([file.inApp, file.email, file.digest]).toEqual([true, false, true]);
    expect(view.account.typeCount).toBeGreaterThan(0);
    expect(view.canManageCompany).toBe(true);
    expect((await controller.get(context, principal('member'))).canManageCompany).toBe(false);
  });

  it('writes e-mail/digest to the matrix store and in-app to the per-kind switch, own seat only', async () => {
    const { controller, writes } = fixture();
    let view = await controller.set(context, principal('member'), {
      kind: 'file',
      channel: 'email',
      enabled: true,
    });
    expect(view.rows.find((row) => row.kind === 'file')!.email).toBe(true);
    view = await controller.set(context, principal('member'), {
      kind: 'message',
      channel: 'in_app',
      enabled: false,
    });
    expect(view.rows.find((row) => row.kind === 'message')!.inApp).toBe(false);
    expect(writes).toEqual([`cell:${ME}:file:email:true`, `kind:${ME}:message:false`]);
  });

  it('refuses to turn off a company-forced kind (409) and rejects bad input (400), no write', async () => {
    const { controller, writes } = fixture(['client_request']);
    await expect(
      controller.set(context, principal('member'), {
        kind: 'client_request',
        channel: 'email',
        enabled: false,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      controller.set(context, principal('member'), { kind: 'nope', channel: 'push', enabled: 1 }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(writes).toEqual([]);
    const forced = (await controller.get(context, principal('member'))).rows[0]!;
    expect([forced.forcedEmail, forced.inApp, forced.email]).toEqual([true, true, true]);
  });

  it('sits behind work.read on both routes', () => {
    const proto = NotificationMatrixController.prototype;
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, proto.get)).toBe('work.read');
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, proto.set)).toBe('work.read');
  });

  it('allowlists the forced-e-mail kinds as a canonical csv, empty by default', () => {
    expect(defaultFor('notification_forced_email_kinds')).toBe('');
    expect(validateValue('notification_forced_email_kinds', ' mention,client_request ')).toEqual({
      ok: true,
      value: 'client_request,mention',
    });
    expect(validateValue('notification_forced_email_kinds', 'push').ok).toBe(false);
  });
});
