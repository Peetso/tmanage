import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { BillingProfileController } from './profile.controller.js';
import type { BillingProfileInput, BillingProfileRepository } from './profile.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingProfileRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';

// Billing profile (x180) — one test per behaviour (0.05 feature budget): the defaults read, a valid
// update persisting, the payment-instrument / malformed / over-length refusals with no write, and the
// `org.manage` refusal. Real `authorize()` runs (no guard is mocked), so the 403 is the true verdict.

const ORG = 'org-under-test';

/** An owner — the one internal role whose ceiling holds `org.manage`. */
function ownerPrincipal(): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG } as TenantContext;

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

interface RepoSpy {
  finds: number;
  upserts: BillingProfileInput[];
}

function fakeRepository(row: BillingProfileRow | null, spy: RepoSpy): BillingProfileRepository {
  return {
    find: () => {
      spy.finds += 1;
      return Promise.resolve(row);
    },
    upsert: (_r: never, _c: TenantContext, input: BillingProfileInput) => {
      spy.upserts.push(input);
      return Promise.resolve({
        id: 'billing-1',
        organizationId: ORG,
        billingEmail: input.billingEmail,
        companyName: input.companyName,
        taxId: input.taxId,
        addressJson: input.address,
        createdAt: new Date('2026-09-27T00:00:00.000Z'),
        updatedAt: new Date('2026-09-27T12:00:00.000Z'),
      } as BillingProfileRow);
    },
  } as unknown as BillingProfileRepository;
}

function controller(row: BillingProfileRow | null): { c: BillingProfileController; spy: RepoSpy } {
  const spy: RepoSpy = { finds: 0, upserts: [] };
  return { c: new BillingProfileController(fakeDatabase(), fakeRepository(row, spy)), spy };
}

describe('BillingProfileController', () => {
  it('reads the defaults when no profile has been saved', async () => {
    const { c } = controller(null);
    await expect(c.read(context, ownerPrincipal())).resolves.toEqual({
      billingEmail: null,
      companyName: null,
      taxId: null,
      address: {
        line1: null,
        line2: null,
        city: null,
        region: null,
        postalCode: null,
        country: null,
      },
      updatedAt: null,
    });
  });

  it('persists a valid update and returns the saved view', async () => {
    const { c, spy } = controller(null);
    const view = await c.update(context, ownerPrincipal(), {
      billingEmail: 'billing@example.com',
      companyName: 'Acme Studio',
      taxId: 'GB123456789',
      address: { line1: '1 High St', city: 'London', country: 'GB' },
    });
    expect(spy.upserts).toHaveLength(1);
    expect(spy.upserts[0]).toEqual({
      billingEmail: 'billing@example.com',
      companyName: 'Acme Studio',
      taxId: 'GB123456789',
      address: {
        line1: '1 High St',
        line2: null,
        city: 'London',
        region: null,
        postalCode: null,
        country: 'GB',
      },
    });
    expect(view.billingEmail).toBe('billing@example.com');
    expect(view.updatedAt).toBe('2026-09-27T12:00:00.000Z');
  });

  it('rejects a malformed email with 400 and no write', async () => {
    const { c, spy } = controller(null);
    await expect(
      c.update(context, ownerPrincipal(), { billingEmail: 'not-an-email' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(spy.upserts).toHaveLength(0);
  });

  it('rejects an over-length field with 400 and no write', async () => {
    const { c, spy } = controller(null);
    await expect(
      c.update(context, ownerPrincipal(), { companyName: 'x'.repeat(191) }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(spy.upserts).toHaveLength(0);
  });

  it('rejects a card/PAN-shaped value in any field with 400 and no write', async () => {
    const { c, spy } = controller(null);
    // A Luhn-valid 16-digit test PAN. It must never be stored in a billing field.
    await expect(
      c.update(context, ownerPrincipal(), { taxId: '4242 4242 4242 4242' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(spy.upserts).toHaveLength(0);
  });

  it('refuses a principal without org.manage and never touches the repository', async () => {
    const { c, spy } = controller(null);
    const notManager: Principal = { ...ownerPrincipal(), role: 'workspace_admin' };
    await expect(c.read(context, notManager)).rejects.toBeInstanceOf(ApiError);
    await expect(
      c.update(context, notManager, { billingEmail: 'billing@example.com' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(spy.finds).toBe(0);
    expect(spy.upserts).toHaveLength(0);
  });
});
