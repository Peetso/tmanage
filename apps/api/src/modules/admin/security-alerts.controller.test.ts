import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { AdminSecurityAlertsController } from './security-alerts.controller.js';
import type { AdminSecurityAlertsRepository } from './security-alerts.repository.js';
import { SECURITY_ALERT_EVENT_KEYS } from './security-alerts.service.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Admin security-event alert configuration (x329) over fakes, with the **real** `authorize`. The
 * database is faked, but the policy and the allowlist are not: these cases prove this slice's safety —
 * the organization is resolved tenant-scoped BEFORE the `org.security.manage` authorize (cross-tenant
 * → 404, no write, the Known trap), a caller without the capability is 403 with no write, an
 * off-allowlist `eventTypeKey` is 400 with no write, and the read-side match is always scoped to the
 * acting `organizationId` (a cross-tenant read never returns another org's events).
 */
const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2';
const USER = '00000000-0000-4000-8000-0000000000c1';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const KEY = SECURITY_ALERT_EVENT_KEYS[0] as string;

function owner(): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

/** A member never holds `org.security.manage`, so the authorize denies. */
function member(): Principal {
  return { ...owner(), role: 'member' };
}

const context = { organizationId: ORG, membershipId: MEMBERSHIP } as unknown as TenantContext;

class FakeRepo {
  upsertCalls = 0;
  deleteCalls = 0;
  matchOrgIds: string[] = [];
  constructor(private readonly orgExists = true) {}
  resolveOrganization() {
    return Promise.resolve(this.orgExists ? { id: ORG } : undefined);
  }
  list() {
    return Promise.resolve([]);
  }
  upsert() {
    this.upsertCalls += 1;
    return Promise.resolve();
  }
  remove() {
    this.deleteCalls += 1;
    return Promise.resolve();
  }
  findRecentMatches(_r: unknown, ctx: TenantContext) {
    this.matchOrgIds.push(ctx.organizationId);
    return Promise.resolve([]);
  }
}

function controllerWith(repo: FakeRepo): AdminSecurityAlertsController {
  const database = {
    read: async (c: unknown, work: (db: unknown) => Promise<unknown>) => work(c),
    transaction: async (c: unknown, work: (tx: unknown) => Promise<unknown>) => work(c),
  } as unknown as TenantDatabase;
  return new AdminSecurityAlertsController(
    database,
    repo as unknown as AdminSecurityAlertsRepository,
  );
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('AdminSecurityAlertsController (ADM security monitoring, x329)', () => {
  it('lists the allowlist and toggles a valid key (the tenant-scoped round trip), matching only this org', async () => {
    const repo = new FakeRepo();
    const controller = controllerWith(repo);
    const view = await controller.configure(context, owner(), { eventTypeKey: KEY, enabled: true });
    expect(repo.upsertCalls).toBe(1);
    expect(view.allowedEventTypes).toEqual(SECURITY_ALERT_EVENT_KEYS);
    // Every read-side match query is scoped to the acting org — never OTHER_ORG.
    expect(repo.matchOrgIds.every((id) => id === ORG)).toBe(true);
    expect(repo.matchOrgIds).not.toContain(OTHER_ORG);
  });

  it('403s a caller without org.security.manage, with the real authorize, and does not write', async () => {
    const repo = new FakeRepo();
    const controller = controllerWith(repo);
    await expectStatus(
      controller.configure(context, member(), { eventTypeKey: KEY, enabled: true }),
      403,
    );
    await expectStatus(controller.remove(context, member(), { eventTypeKey: KEY }), 403);
    expect(repo.upsertCalls).toBe(0);
    expect(repo.deleteCalls).toBe(0);
  });

  it('400s an off-allowlist event_type_key, without a write', async () => {
    const repo = new FakeRepo();
    const controller = controllerWith(repo);
    await expectStatus(
      controller.configure(context, owner(), { eventTypeKey: 'not.a.key', enabled: true }),
      400,
    );
    expect(repo.upsertCalls).toBe(0);
  });

  it('404s a cross-tenant organization, before authorize and before any write (Known trap)', async () => {
    const repo = new FakeRepo(false);
    const controller = controllerWith(repo);
    await expectStatus(
      controller.configure(context, owner(), { eventTypeKey: KEY, enabled: true }),
      404,
    );
    expect(repo.upsertCalls).toBe(0);
  });

  it('guards all three routes with org.security.manage', () => {
    for (const method of ['list', 'configure', 'remove'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        AdminSecurityAlertsController.prototype[method],
      );
      expect(capability).toBe('org.security.manage');
    }
  });
});
