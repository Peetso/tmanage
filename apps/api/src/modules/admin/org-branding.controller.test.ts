import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import {
  AdminOrgBrandingController,
  OrgBrandingController,
  parseSaveBody,
} from './org-branding.controller.js';
import { OrgBrandingService } from './org-branding.service.js';
import type { OrgBrandingInput, OrgBrandingRepository } from './org-branding.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OrgBrandingRow } from '../../common/database/schema.js';

/**
 * ADM / org identity (x327) — set + read over fakes, with the **real** `authorize`.
 *
 * The database and repository are faked, but the policy is not: a real `Principal` runs through the
 * real evaluator, so these cases prove the rules that are the whole of this slice's safety — the
 * organization is resolved tenant-scoped BEFORE the org-wide `org.manage` authorize (a cross-tenant
 * context is a 404 with no upsert, the Known trap); a caller without `org.manage` is a 403 with no
 * upsert; a malformed accent colour or over-length text is a 400 with no upsert; and the set/read
 * routes sit behind `org.manage` / `work.read`. No DB in this suite (the chain owns the round-trip).
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

/** An org_admin — holds every capability except `org.manage`, so the set authorize denies (403). */
function orgAdmin(): Principal {
  return { ...owner(), role: 'org_admin' };
}

const context = { organizationId: ORG, userId: OWNER_USER } as unknown as TenantContext;

/**
 * An in-memory {@link OrgBrandingRepository}. `orgExists` controls the resolve-before-authorize step:
 * a cross-tenant context is modelled by constructing it `false`.
 */
class FakeOrgBrandingRepository {
  row: OrgBrandingRow | null = null;
  upsertCalls = 0;

  constructor(private readonly orgExists = true) {}

  resolveOrganization(): Promise<{ readonly id: string } | undefined> {
    return Promise.resolve(this.orgExists ? { id: ORG } : undefined);
  }

  findForOrganization(): Promise<OrgBrandingRow | null> {
    return Promise.resolve(this.row);
  }

  upsert(_r: unknown, _c: unknown, input: OrgBrandingInput): Promise<OrgBrandingRow> {
    this.upsertCalls += 1;
    this.row = {
      id: this.row?.id ?? 'ob-1',
      organizationId: ORG,
      productName: input.productName,
      accentColor: input.accentColor,
      logoText: input.logoText,
      updatedBy: input.updatedBy,
      createdAt: this.row?.createdAt ?? new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-28T00:00:00.000Z'),
    } as unknown as OrgBrandingRow;
    return Promise.resolve(this.row);
  }
}

function serviceWith(repo: FakeOrgBrandingRepository): OrgBrandingService {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new OrgBrandingService(database, repo as unknown as OrgBrandingRepository);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('OrgBrandingService (ADM org branding, x327)', () => {
  it('upserts as the context user and reads it back; a second save is idempotent (one row)', async () => {
    const repo = new FakeOrgBrandingRepository();
    const service = serviceWith(repo);

    const saved = await service.set(context, owner(), {
      productName: 'Acme Studio',
      accentColor: '#7c3aed',
      logoText: 'AS',
    });
    expect(repo.upsertCalls).toBe(1);
    expect(saved).toMatchObject({
      productName: 'Acme Studio',
      accentColor: '#7c3aed',
      logoText: 'AS',
      updatedBy: OWNER_USER,
    });

    await service.set(context, owner(), {
      productName: 'Acme',
      accentColor: '#059669',
      logoText: null,
    });
    expect(repo.upsertCalls).toBe(2);
    expect(repo.row?.id).toBe('ob-1'); // same row replaced in place

    const read = await service.get(context);
    expect(read.productName).toBe('Acme');
    expect(read.accentColor).toBe('#059669');
  });

  it('reads defaults (no updatedBy) for a studio that has never configured its branding', async () => {
    const read = await serviceWith(new FakeOrgBrandingRepository()).get(context);
    expect(read).toMatchObject({
      productName: null,
      accentColor: '#2563eb',
      logoText: null,
      updatedBy: null,
      updatedAt: null,
    });
  });

  it('403s a caller without org.manage, with the real authorize, and does not upsert', async () => {
    const repo = new FakeOrgBrandingRepository();
    await expectStatus(
      serviceWith(repo).set(context, orgAdmin(), {
        productName: 'x',
        accentColor: '#2563eb',
        logoText: null,
      }),
      403,
    );
    expect(repo.upsertCalls).toBe(0);
  });

  it('404s a cross-tenant organization, before authorize and before any upsert (Known trap)', async () => {
    const repo = new FakeOrgBrandingRepository(false);
    await expectStatus(
      serviceWith(repo).set(context, owner(), {
        productName: 'x',
        accentColor: '#2563eb',
        logoText: null,
      }),
      404,
    );
    expect(repo.upsertCalls).toBe(0);
  });
});

describe('org branding body validation (x327)', () => {
  it('rejects a malformed accent colour with 400 (no upsert reachable)', () => {
    for (const accentColor of ['blue', '#12', '#12345', '1234567', '#GGGGGG']) {
      expect(() => parseSaveBody({ accentColor })).toThrowError(
        expect.objectContaining({ status: 400 }),
      );
    }
  });

  it('rejects over-length product name and logo text with 400', () => {
    expect(() => parseSaveBody({ productName: 'a'.repeat(121) })).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => parseSaveBody({ logoText: 'a'.repeat(49) })).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });

  it('accepts #RGB and #RRGGBB, and stores empty text as null, defaulting the rest', () => {
    expect(parseSaveBody({ accentColor: '#fff' })).toEqual({
      productName: null,
      accentColor: '#fff',
      logoText: null,
    });
    expect(parseSaveBody({ productName: '  ', logoText: 'AS' })).toEqual({
      productName: null,
      accentColor: '#2563eb',
      logoText: 'AS',
    });
  });
});

describe('org branding route capabilities (x327)', () => {
  it('guards the admin set with org.manage and the member read with work.read', () => {
    expect(
      Reflect.getMetadata(REQUIRED_CAPABILITY, AdminOrgBrandingController.prototype.save),
    ).toBe('org.manage');
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, OrgBrandingController.prototype.get)).toBe(
      'work.read',
    );
  });
});
