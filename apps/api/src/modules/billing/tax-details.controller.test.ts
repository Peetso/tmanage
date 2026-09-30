import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { BillingTaxDetailsController } from './tax-details.controller.js';
import { BillingTaxDetailsService } from './tax-details.service.js';
import type {
  BillingTaxDetailsInput,
  BillingTaxDetailsRepository,
} from './tax-details.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingTaxDetailsRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';

// Billing tax / legal-entity details (x283) — one test per behaviour (0.05 feature budget): the
// defaults read, a valid upsert, the invalid-country / missing-name / PAN refusals with no write, and
// the `org.manage` refusal. Real `authorize()` runs (no guard is mocked), so the 403 is the true
// verdict, and a real service wired to a fake repository exercises the validation end to end.

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
  upserts: BillingTaxDetailsInput[];
}

function fakeRepository(
  row: BillingTaxDetailsRow | null,
  spy: RepoSpy,
): BillingTaxDetailsRepository {
  return {
    find: () => {
      spy.finds += 1;
      return Promise.resolve(row);
    },
    upsert: (_r: never, _c: TenantContext, input: BillingTaxDetailsInput) => {
      spy.upserts.push(input);
      return Promise.resolve({
        id: 'tax-1',
        organizationId: ORG,
        legalName: input.legalName,
        taxId: input.taxId,
        registrationNo: input.registrationNo,
        taxCountry: input.taxCountry,
        createdAt: new Date('2026-09-27T00:00:00.000Z'),
        updatedAt: new Date('2026-09-27T12:00:00.000Z'),
      } as BillingTaxDetailsRow);
    },
  } as unknown as BillingTaxDetailsRepository;
}

function controller(row: BillingTaxDetailsRow | null): {
  c: BillingTaxDetailsController;
  spy: RepoSpy;
} {
  const spy: RepoSpy = { finds: 0, upserts: [] };
  const service = new BillingTaxDetailsService(fakeDatabase(), fakeRepository(row, spy));
  return { c: new BillingTaxDetailsController(service), spy };
}

describe('BillingTaxDetailsController', () => {
  it('reads the defaults when no tax details have been saved', async () => {
    const { c } = controller(null);
    await expect(c.read(context, ownerPrincipal())).resolves.toEqual({
      legalName: null,
      taxId: null,
      registrationNo: null,
      taxCountry: null,
      updatedAt: null,
    });
  });

  it('persists a valid upsert and returns the saved view', async () => {
    const { c, spy } = controller(null);
    const view = await c.update(context, ownerPrincipal(), {
      legalName: 'Acme Studio Ltd',
      taxId: 'GB123456789',
      registrationNo: '01234567',
      taxCountry: 'gb',
    });
    expect(spy.upserts).toHaveLength(1);
    expect(spy.upserts[0]).toEqual({
      legalName: 'Acme Studio Ltd',
      taxId: 'GB123456789',
      registrationNo: '01234567',
      // Upper-cased before the allowlist check.
      taxCountry: 'GB',
    });
    expect(view.legalName).toBe('Acme Studio Ltd');
    expect(view.taxCountry).toBe('GB');
    expect(view.updatedAt).toBe('2026-09-27T12:00:00.000Z');
  });

  it('rejects an invalid taxCountry with 400 and no write', async () => {
    const { c, spy } = controller(null);
    await expect(
      c.update(context, ownerPrincipal(), { legalName: 'Acme Studio Ltd', taxCountry: 'ZZ' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(spy.upserts).toHaveLength(0);
  });

  it('rejects a missing/empty legalName with 400 and no write', async () => {
    const { c, spy } = controller(null);
    await expect(
      c.update(context, ownerPrincipal(), { legalName: '   ', taxCountry: 'GB' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(spy.upserts).toHaveLength(0);
  });

  it('rejects a card/PAN-shaped value in any field with 400 and no write', async () => {
    const { c, spy } = controller(null);
    // A Luhn-valid 16-digit test PAN. It must never be stored in a tax field.
    await expect(
      c.update(context, ownerPrincipal(), {
        legalName: 'Acme Studio Ltd',
        taxId: '4242 4242 4242 4242',
        taxCountry: 'GB',
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(spy.upserts).toHaveLength(0);
  });

  it('refuses a principal without org.manage and never touches the repository', async () => {
    const { c, spy } = controller(null);
    const notManager: Principal = { ...ownerPrincipal(), role: 'org_admin' };
    await expect(c.read(context, notManager)).rejects.toBeInstanceOf(ApiError);
    await expect(
      c.update(context, notManager, { legalName: 'Acme Studio Ltd', taxCountry: 'GB' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(spy.finds).toBe(0);
    expect(spy.upserts).toHaveLength(0);
  });
});
