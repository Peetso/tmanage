import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PLATFORM_PERMISSIONS } from '@tmanage/domain';
import type { PlatformPermission } from '@tmanage/domain';
import { ensureRequestState } from '../../common/http/request-state.js';
import { PlatformOrganizationsController } from './organizations/organizations.controller.js';
import { parsePlatformAdminEmails } from './platform-admin.access.js';
import { PlatformAdminController } from './platform-admin.controller.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from './platform-admin.guard.js';
import type { PlatformAdminActor, PlatformAdminLookup } from './platform-admin.guard.js';
import type { PlatformAdminAccount } from './platform-admin.repository.js';
import type { PlatformAdminRecord } from './platform-admins.repository.js';
import { PlatformTeamController } from './team/team.controller.js';

/** Who reaches `/v1/platform/*` — the real guard, Reflector and route metadata over a fake lookup. */

const USER = '0199aa00-0000-7000-8000-0000000000a1';

type Route = 'me' | 'suspend' | 'companies' | 'team';

const ROUTES: Record<Route, [object, string]> = {
  me: [PlatformAdminController, 'me'],
  suspend: [PlatformOrganizationsController, 'suspend'],
  companies: [PlatformOrganizationsController, 'companies'],
  team: [PlatformTeamController, 'list'],
};

interface Attempt {
  allowlist: string;
  account?: Partial<PlatformAdminAccount>;
  stepUp?: boolean;
  scheme?: 'cookie' | 'personal_access_token';
  route?: Route;
  /** A `platform_admins` row for the person; omitted = none. */
  row?: Partial<PlatformAdminRecord> | null;
  /** Whether the team table has any active row (feature on with an empty list). */
  anyActive?: boolean;
  /** Leave the optional v2 lookup methods out (an older, env-only lookup). */
  legacyLookup?: boolean;
}

type Outcome = { status: number; code: string | undefined; details?: unknown } | PlatformAdminActor;

async function attempt(o: Attempt): Promise<Outcome> {
  const account = {
    userId: USER,
    email: 'Peter@Example.com',
    displayName: 'P',
    emailVerified: true,
    mfaEnabled: true,
    ...o.account,
  };
  const row: PlatformAdminRecord | null = o.row
    ? {
        id: 'admin-1',
        userId: USER,
        preset: 'support',
        customPermissions: null,
        permissions: ['platform.orgs.view', 'platform.people.view'],
        status: 'active',
        ...o.row,
      }
    : null;
  const lookup: PlatformAdminLookup = {
    findAccount: async () => account,
    findLiveStepUp: async () =>
      o.stepUp ? { expiresAt: new Date(Date.now() + 600_000), mfaVerified: true } : null,
    ...(o.legacyLookup
      ? {}
      : {
          findPlatformAdmin: async () => row,
          hasActivePlatformAdmins: async () => o.anyActive ?? row?.status === 'active',
        }),
  };
  const guard = new PlatformAdminGuard(
    new Reflector(),
    parsePlatformAdminEmails(o.allowlist),
    lookup,
  );
  const request = { headers: {} };
  const state = ensureRequestState(request);
  state.session = { sessionId: 's', userId: USER };
  state.authScheme = o.scheme ?? 'cookie';
  const [controller, method] = ROUTES[o.route ?? 'suspend'];
  const handler = (controller as { prototype: Record<string, unknown> }).prototype[method];
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => controller,
  } as unknown as ExecutionContext;
  return guard.canActivate(context).then(
    () => actorOf(context),
    (error: { status: number; code?: string; details?: unknown }) => ({
      status: error.status,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    }),
  );
}

/** Read the actor back through the real param decorator's factory. */
function actorOf(context: ExecutionContext): PlatformAdminActor {
  class Probe {
    handle(@CurrentPlatformAdmin() _actor: unknown): void {}
  }
  const meta = Reflect.getMetadata('__routeArguments__', Probe, 'handle') as Record<
    string,
    { factory: (data: unknown, ctx: ExecutionContext) => PlatformAdminActor }
  >;
  const entry = Object.values(meta)[0];
  if (!entry) throw new Error('no param decorator metadata');
  return entry.factory(undefined, context);
}

function admitted(outcome: Outcome): outcome is PlatformAdminActor {
  return 'account' in outcome;
}

describe('PlatformAdminGuard', () => {
  it('is a 404 for everyone while the server list is empty and the team has no active row', async () => {
    expect(await attempt({ allowlist: '', stepUp: true })).toEqual({
      status: 404,
      code: 'not_found',
    });
    expect(await attempt({ allowlist: '', stepUp: true, legacyLookup: true })).toEqual({
      status: 404,
      code: 'not_found',
    });
  });

  it('refuses an email not on the list — an organization owner included — with the same 404', async () => {
    const owner = await attempt({
      allowlist: 'peter@example.com',
      account: { email: 'owner@customer.test' },
      stepUp: true,
    });
    expect(owner).toEqual({ status: 404, code: 'not_found' });
    expect(
      await attempt({
        allowlist: 'peter@example.com',
        account: { emailVerified: false },
        stepUp: true,
      }),
    ).toMatchObject({ status: 404 });
    expect(
      await attempt({
        allowlist: 'peter@example.com',
        scheme: 'personal_access_token',
        stepUp: true,
      }),
    ).toMatchObject({ status: 404 });
  });

  it('requires a fresh password (+ two-step code) confirmation for every action', async () => {
    expect(await attempt({ allowlist: 'PETER@example.com', stepUp: false })).toEqual({
      status: 403,
      code: 'reauthentication_required',
    });
    expect(
      await attempt({
        allowlist: 'peter@example.com',
        account: { mfaEnabled: false },
        stepUp: false,
      }),
    ).toMatchObject({ status: 403 });
    expect(admitted(await attempt({ allowlist: 'peter@example.com', stepUp: true }))).toBe(true);
  });

  it('lets an admin read their own status before confirming', async () => {
    expect(
      admitted(await attempt({ allowlist: 'peter@example.com', stepUp: false, route: 'me' })),
    ).toBe(true);
  });

  it('makes a server-list admin a super admin with every permission, whatever their team row says', async () => {
    const outcome = await attempt({
      allowlist: 'peter@example.com',
      stepUp: true,
      row: { preset: 'auditor', status: 'disabled', permissions: [] },
      route: 'team',
    });
    expect(admitted(outcome)).toBe(true);
    if (!admitted(outcome)) return;
    expect(outcome).toMatchObject({ source: 'env', preset: 'super_admin', adminId: 'admin-1' });
    expect(outcome.permissions).toEqual([...PLATFORM_PERMISSIONS]);
    expect(outcome.stepUpRemainingSeconds).toBeGreaterThan(500);
  });

  it('admits an active team row with an empty server list, carrying its preset and permissions', async () => {
    const outcome = await attempt({
      allowlist: '',
      stepUp: true,
      row: {},
      route: 'companies',
    });
    expect(admitted(outcome)).toBe(true);
    if (!admitted(outcome)) return;
    expect(outcome).toMatchObject({
      source: 'db',
      preset: 'support',
      adminId: 'admin-1',
      permissions: ['platform.orgs.view', 'platform.people.view'],
    });
  });

  it('refuses a disabled team row with the 404, even while other admins keep the feature on', async () => {
    expect(
      await attempt({
        allowlist: 'someone@else.test',
        stepUp: true,
        row: { status: 'disabled' },
      }),
    ).toEqual({ status: 404, code: 'not_found' });
    expect(
      await attempt({ allowlist: '', anyActive: true, stepUp: true, row: { status: 'disabled' } }),
    ).toEqual({ status: 404, code: 'not_found' });
  });

  it("answers 403 platform_permission_missing naming the key the admin's preset lacks", async () => {
    const lifecycle: PlatformPermission = 'platform.orgs.lifecycle';
    expect(await attempt({ allowlist: '', stepUp: true, row: {}, route: 'suspend' })).toEqual({
      status: 403,
      code: 'platform_permission_missing',
      details: [{ field: 'permission', message: lifecycle }],
    });
    // Checked before the step-up: a password would not help, so the screen says what is missing.
    expect(await attempt({ allowlist: '', stepUp: false, row: {}, route: 'team' })).toMatchObject({
      status: 403,
      code: 'platform_permission_missing',
    });
  });
});
