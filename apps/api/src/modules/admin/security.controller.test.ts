import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { SecuritySettingsController } from './security.controller.js';
import type { SecuritySettingsRepository } from './security.repository.js';
import { canonicaliseEntry, validateIpAllowlist, MAX_IP_ALLOWLIST_ENTRIES } from './cidr.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { SecuritySettingsRow } from '../../common/database/schema.js';

/**
 * Organization security settings (x176) read + update over fakes, with the **real** `authorize`.
 *
 * The database is faked, but the policy and the validation are not: a real `Principal` runs through the
 * real evaluator, and the real `cidr.ts` validates the allowlist, so these cases prove the whole of
 * this slice's safety — the organization is resolved tenant-scoped BEFORE the org-wide `org.manage`
 * authorize (a cross-tenant context is a 404 with no write, the Known trap), a malformed/over-count IP
 * allowlist or a non-boolean `enforce2fa` is a 400 with no write (nothing partially valid is stored),
 * and both routes sit behind `org.manage` (a caller without it is refused 403 both by `CapabilityGuard`,
 * asserted through the route metadata, and by the handler's real authorize).
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

/** A workspace_admin — does not hold `org.manage`, so the write/read authorize denies. */
function orgAdmin(): Principal {
  return { ...owner(), role: 'workspace_admin' };
}

const context = {
  organizationId: ORG,
  membershipId: MEMBERSHIP,
} as unknown as TenantContext;

/**
 * An in-memory {@link SecuritySettingsRepository}. `orgExists` controls the resolve-before-authorize
 * step: a cross-tenant context is modelled by constructing it `false`, exactly what the real
 * tenant-scoped resolve returns for an organization not in this tenant.
 */
class FakeSecurityRepository {
  row: SecuritySettingsRow | undefined;
  upsertCalls = 0;

  constructor(private readonly orgExists = true) {}

  resolveOrganization(): Promise<{ readonly id: string } | undefined> {
    return Promise.resolve(this.orgExists ? { id: ORG } : undefined);
  }

  find(): Promise<SecuritySettingsRow | undefined> {
    return Promise.resolve(this.row);
  }

  upsert(
    _r: unknown,
    _c: unknown,
    input: { enforce2fa: boolean; ipAllowlist: readonly string[]; updatedBy: string },
  ): Promise<void> {
    this.upsertCalls += 1;
    this.row = {
      id: 'sec-1',
      organizationId: ORG,
      enforce2fa: input.enforce2fa,
      ipAllowlistJson: [...input.ipAllowlist],
      updatedBy: input.updatedBy,
      updatedAt: new Date('2026-09-27T00:00:00.000Z'),
      createdAt: new Date('2026-09-27T00:00:00.000Z'),
    };
    return Promise.resolve();
  }
}

function controllerWith(repo: FakeSecurityRepository): SecuritySettingsController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new SecuritySettingsController(database, repo as unknown as SecuritySettingsRepository);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('SecuritySettingsController (ADM security, x176)', () => {
  it('reads the defaults, sets a valid posture, and reads it back (the tenant-scoped round trip)', async () => {
    const repo = new FakeSecurityRepository();
    const controller = controllerWith(repo);

    const before = await controller.read(context, owner());
    expect(before).toEqual({ enforce2fa: false, ipAllowlist: [] });

    const after = await controller.set(context, owner(), {
      enforce2fa: true,
      ipAllowlist: ['203.0.113.0/24', '2001:db8::/32', ' '],
    });
    expect(after.enforce2fa).toBe(true);
    expect(after.ipAllowlist).toEqual(['203.0.113.0/24', '2001:db8::/32']);
    expect(repo.upsertCalls).toBe(1);
  });

  it('400s a malformed CIDR/IP entry, without a write (nothing partially valid is stored)', async () => {
    const repo = new FakeSecurityRepository();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.set(context, owner(), { enforce2fa: false, ipAllowlist: ['10.0.0.0/24', 'nope'] }),
      400,
    );
    await expectStatus(
      controller.set(context, owner(), { enforce2fa: false, ipAllowlist: ['10.0.0.0/40'] }),
      400,
    );
    expect(repo.upsertCalls).toBe(0);
  });

  it('400s an over-count allowlist, without a write', async () => {
    const repo = new FakeSecurityRepository();
    const controller = controllerWith(repo);
    const tooMany = Array.from({ length: MAX_IP_ALLOWLIST_ENTRIES + 1 }, (_v, i) => `10.0.0.${i}`);

    await expectStatus(
      controller.set(context, owner(), { enforce2fa: false, ipAllowlist: tooMany }),
      400,
    );
    expect(repo.upsertCalls).toBe(0);
  });

  it('400s a non-boolean enforce2fa, without a write', async () => {
    const repo = new FakeSecurityRepository();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.set(context, owner(), {
        enforce2fa: 'yes' as unknown as boolean,
        ipAllowlist: [],
      }),
      400,
    );
    expect(repo.upsertCalls).toBe(0);
  });

  it('404s a cross-tenant organization, before authorize and before any write (Known trap)', async () => {
    const repo = new FakeSecurityRepository(false);
    const controller = controllerWith(repo);

    await expectStatus(
      controller.set(context, owner(), { enforce2fa: true, ipAllowlist: [] }),
      404,
    );
    expect(repo.upsertCalls).toBe(0);
  });

  it('403s a caller without org.manage on the write, with the real authorize, and does not write', async () => {
    const repo = new FakeSecurityRepository();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.set(context, orgAdmin(), { enforce2fa: true, ipAllowlist: [] }),
      403,
    );
    expect(repo.upsertCalls).toBe(0);
  });

  it('403s a caller without org.manage on the read, with the real authorize', async () => {
    const repo = new FakeSecurityRepository();
    const controller = controllerWith(repo);

    await expectStatus(controller.read(context, orgAdmin()), 403);
  });

  it('guards both routes with org.manage, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['read', 'set'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        SecuritySettingsController.prototype[method],
      );
      expect(capability).toBe('org.manage');
    }
  });
});

describe('cidr — IP/CIDR validation (x176, pure fn)', () => {
  it('accepts valid IPv4/IPv6 addresses and CIDR ranges, and canonicalises them', () => {
    expect(canonicaliseEntry('192.168.1.1')).toBe('192.168.1.1');
    expect(canonicaliseEntry('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(canonicaliseEntry('2001:DB8::1')).toBe('2001:db8::1');
    expect(canonicaliseEntry('2001:db8::/32')).toBe('2001:db8::/32');
    expect(canonicaliseEntry('::ffff:1.2.3.4')).toBe('::ffff:1.2.3.4');
  });

  it('rejects malformed addresses, out-of-range octets/prefixes, and leading zeros', () => {
    for (const bad of [
      'nope',
      '256.0.0.1',
      '01.1.1.1',
      '10.0.0.0/33',
      '2001:db8::/129',
      '1.2.3',
      '12345::',
      'gggg::1',
      '::/', // missing prefix digits
    ]) {
      expect(canonicaliseEntry(bad)).toBeNull();
    }
  });

  it('drops blanks, de-duplicates, and rejects a non-array or non-string entry', () => {
    expect(validateIpAllowlist(['10.0.0.1', ' ', '10.0.0.1'])).toEqual({
      ok: true,
      value: ['10.0.0.1'],
    });
    expect(validateIpAllowlist('10.0.0.1').ok).toBe(false);
    expect(validateIpAllowlist([42]).ok).toBe(false);
  });
});
