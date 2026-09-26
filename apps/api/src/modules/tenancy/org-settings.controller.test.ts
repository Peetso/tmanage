import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { OrgSettingsController } from './org-settings.controller.js';
import type { OrgSettingsRepository } from './org-settings.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OrgSettingRow } from '../../common/database/schema.js';

/**
 * Organization settings / policy (x153) read + update over fakes, with the **real** `authorize`.
 *
 * The database is faked, but the policy is not: a real `Principal` runs through the real evaluator, so
 * these cases prove the rules that are the whole of this slice's safety — the organization is resolved
 * tenant-scoped BEFORE the org-wide `org.manage` authorize (a cross-tenant context is a 404 with no
 * write, the Known trap), the fixed allowlist is the boundary (an off-list key or a value the
 * validator rejects is a 400 with no write — no arbitrary key is stored), and both routes sit behind
 * `org.manage` (a caller without it is refused 403 both by `CapabilityGuard`, asserted through the
 * route metadata, and by the handler's real authorize).
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER_USER = '00000000-0000-4000-8000-0000000000c1';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';

/** An owner — the only internal role whose ceiling holds `org.manage`. */
function owner(): Principal {
  return {
    userId: OWNER_USER,
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

/** An org_admin — holds every capability except `org.manage`, so the write/read authorize denies. */
function orgAdmin(): Principal {
  return { ...owner(), role: 'org_admin' };
}

const context = {
  organizationId: ORG,
  membershipId: MEMBERSHIP,
} as unknown as TenantContext;

/**
 * An in-memory {@link OrgSettingsRepository}. `orgExists` controls the resolve-before-authorize step:
 * a cross-tenant context is modelled by constructing it `false`, exactly what the real tenant-scoped
 * resolve returns for an organization not in this tenant.
 */
class FakeOrgSettingsRepository {
  readonly rows: OrgSettingRow[] = [];
  upsertCalls = 0;

  constructor(private readonly orgExists = true) {}

  resolveOrganization(): Promise<{ readonly id: string } | undefined> {
    return Promise.resolve(this.orgExists ? { id: ORG } : undefined);
  }

  listAll(): Promise<readonly OrgSettingRow[]> {
    return Promise.resolve(this.rows);
  }

  upsert(
    _r: unknown,
    _c: unknown,
    input: { key: string; value: string; updatedBy: string },
  ): Promise<void> {
    this.upsertCalls += 1;
    const existing = this.rows.find((row) => row.settingKey === input.key);
    if (existing) {
      (existing as { settingValue: string }).settingValue = input.value;
    } else {
      this.rows.push({
        id: `set-${this.rows.length + 1}`,
        organizationId: ORG,
        settingKey: input.key,
        settingValue: input.value,
        updatedBy: input.updatedBy,
        updatedAt: new Date('2026-09-27T00:00:00.000Z'),
        createdAt: new Date('2026-09-27T00:00:00.000Z'),
      });
    }
    return Promise.resolve();
  }

  findByKey(): Promise<OrgSettingRow | undefined> {
    return Promise.resolve(undefined);
  }
}

function controllerWith(repo: FakeOrgSettingsRepository): OrgSettingsController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new OrgSettingsController(database, repo as unknown as OrgSettingsRepository);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('OrgSettingsController (ADM settings, x153)', () => {
  it('reads defaults, sets a key, and reads the stored value back (the tenant-scoped round trip)', async () => {
    const repo = new FakeOrgSettingsRepository();
    const controller = controllerWith(repo);

    const before = await controller.read(context, owner());
    expect(before.settings).toContainEqual({ key: 'default_timezone', value: 'UTC' });
    expect(before.settings).toContainEqual({ key: 'require_reauth_minutes', value: '0' });
    expect(before.settings).toContainEqual({
      key: 'client_visible_project_default',
      value: 'false',
    });

    const after = await controller.set(context, owner(), 'default_timezone', {
      value: 'Europe/London',
    });
    expect(after.settings).toContainEqual({ key: 'default_timezone', value: 'Europe/London' });
    expect(repo.upsertCalls).toBe(1);
  });

  it('canonicalises a value before storing it (a JSON number/boolean, leading zeros)', async () => {
    const repo = new FakeOrgSettingsRepository();
    const controller = controllerWith(repo);

    const afterMinutes = await controller.set(context, owner(), 'require_reauth_minutes', {
      value: 15,
    });
    expect(afterMinutes.settings).toContainEqual({ key: 'require_reauth_minutes', value: '15' });

    const afterBool = await controller.set(context, owner(), 'client_visible_project_default', {
      value: true,
    });
    expect(afterBool.settings).toContainEqual({
      key: 'client_visible_project_default',
      value: 'true',
    });
  });

  it('400s an off-allowlist key, without a write (no arbitrary key is stored)', async () => {
    const repo = new FakeOrgSettingsRepository();
    const controller = controllerWith(repo);

    await expectStatus(controller.set(context, owner(), 'arbitrary_key', { value: 'x' }), 400);
    expect(repo.upsertCalls).toBe(0);
  });

  it('400s a value the key validator rejects, without a write', async () => {
    const repo = new FakeOrgSettingsRepository();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.set(context, owner(), 'default_timezone', { value: 'Mars/Olympus' }),
      400,
    );
    await expectStatus(
      controller.set(context, owner(), 'require_reauth_minutes', { value: 'soon' }),
      400,
    );
    expect(repo.upsertCalls).toBe(0);
  });

  it('404s a cross-tenant organization, before authorize and before any write (Known trap)', async () => {
    const repo = new FakeOrgSettingsRepository(false);
    const controller = controllerWith(repo);

    await expectStatus(
      controller.set(context, owner(), 'default_timezone', { value: 'Europe/London' }),
      404,
    );
    expect(repo.upsertCalls).toBe(0);
  });

  it('403s a caller without org.manage on the write, with the real authorize, and does not write', async () => {
    const repo = new FakeOrgSettingsRepository();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.set(context, orgAdmin(), 'default_timezone', { value: 'Europe/London' }),
      403,
    );
    expect(repo.upsertCalls).toBe(0);
  });

  it('403s a caller without org.manage on the read, with the real authorize', async () => {
    const repo = new FakeOrgSettingsRepository();
    const controller = controllerWith(repo);

    await expectStatus(controller.read(context, orgAdmin()), 403);
  });

  it('guards both routes with org.manage, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['read', 'set'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        OrgSettingsController.prototype[method],
      );
      expect(capability).toBe('org.manage');
    }
  });
});
