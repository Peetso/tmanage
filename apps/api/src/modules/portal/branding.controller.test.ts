import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import {
  PortalBrandingClientController,
  PortalBrandingController,
  parseSaveBody,
} from './branding.controller.js';
import { PortalBrandingService } from './branding.service.js';
import type { PortalBrandingInput } from './branding.repository.js';
import type { PortalBrandingRepository } from './branding.repository.js';
import type { ClientOrganizationsRepository } from '../clients/client-organizations.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ClientOrganizationRow, PortalBrandingRow } from '../../common/database/schema.js';

/**
 * SEC / Client portal branding (x323) — staff write and the client projection, over fakes with **real**
 * `authorize()`. The fakes stand in only for the database and the two repositories; `authorize()` is
 * the real policy, so these cases prove the actual security decisions. No DB in this suite (the chain
 * owns the round-trip).
 */

const ORG = 'org-under-test';
const CLIENT_ORG = 'client-org-under-test';
const OTHER_CLIENT_ORG = 'client-org-someone-else';
const STAFF = 'user-internal-1';

function withRole(kind: 'internal' | 'client', role: string, clientOrg: string | null): Principal {
  return {
    userId: kind === 'client' ? 'client-user-1' : STAFF,
    organizationId: ORG,
    kind,
    role,
    membershipId: 'm-1',
    membershipStatus: 'active',
    clientOrganizationId: clientOrg,
    projectIds: [],
    hasOrgWideScope: kind === 'internal',
  } as Principal;
}

const context = { organizationId: ORG, userId: STAFF } as unknown as TenantContext;

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

function fakeClientOrgs(existing: readonly string[]): ClientOrganizationsRepository {
  return {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(existing.includes(id) ? ({ id } as unknown as ClientOrganizationRow) : null),
  } as unknown as ClientOrganizationsRepository;
}

function fakeBranding(): {
  repo: PortalBrandingRepository;
  saved: { scope: string; input: PortalBrandingInput }[];
} {
  const rows = new Map<string, PortalBrandingRow>();
  const saved: { scope: string; input: PortalBrandingInput }[] = [];
  const repo = {
    findForClientOrg: (_r: never, _c: TenantContext, scope: string) =>
      Promise.resolve(rows.get(scope) ?? null),
    upsert: (_r: never, _c: TenantContext, scope: string, input: PortalBrandingInput) => {
      saved.push({ scope, input });
      const row = {
        id: `pb-${scope}`,
        organizationId: ORG,
        clientOrgScopeId: scope,
        accentColor: input.accentColor,
        welcomeHeading: input.welcomeHeading,
        welcomeText: input.welcomeText,
        updatedBy: input.updatedBy,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-27T00:00:00.000Z'),
      } as unknown as PortalBrandingRow;
      rows.set(scope, row);
      return Promise.resolve(row);
    },
  } as unknown as PortalBrandingRepository;
  return { repo, saved };
}

function serviceFor(
  existingClients: readonly string[],
  branding: ReturnType<typeof fakeBranding>,
): PortalBrandingService {
  return new PortalBrandingService(fakeDatabase(), fakeClientOrgs(existingClients), branding.repo);
}

const VALID_SAVE = { accentColor: '#7c3aed', welcomeHeading: 'Welcome', welcomeText: 'Hi there' };

describe('PortalBrandingService (x323)', () => {
  it('saves as the context user and reads back the full internal record, including updatedBy', async () => {
    const store = fakeBranding();
    const service = serviceFor([CLIENT_ORG], store);

    const saved = await service.save(
      context,
      withRole('internal', 'owner', null),
      CLIENT_ORG,
      VALID_SAVE,
    );

    expect(store.saved[0]?.input.updatedBy).toBe(STAFF);
    expect(saved).toMatchObject({
      clientOrganizationId: CLIENT_ORG,
      accentColor: '#7c3aed',
      updatedBy: STAFF,
    });
  });

  it('projects only the presentation fields to a client, never updatedBy or the scope id', async () => {
    const store = fakeBranding();
    const service = serviceFor([CLIENT_ORG], store);
    await service.save(context, withRole('internal', 'owner', null), CLIENT_ORG, VALID_SAVE);

    const seen = await service.getForClient(
      context,
      withRole('client', 'client_viewer', CLIENT_ORG),
      CLIENT_ORG,
    );

    expect(Object.keys(seen).sort()).toEqual(
      ['accentColor', 'welcomeHeading', 'welcomeText'].sort(),
    );
    expect(seen).not.toHaveProperty('updatedBy');
    expect(seen).not.toHaveProperty('clientOrganizationId');
  });

  it('answers 404 and writes nothing for an unknown or cross-tenant client scope', async () => {
    const store = fakeBranding();
    const service = serviceFor([CLIENT_ORG], store);
    await expect(
      service.save(context, withRole('internal', 'owner', null), 'client-elsewhere', VALID_SAVE),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.saved).toHaveLength(0);
  });

  it('answers 403 and writes nothing when the caller lacks client_member.manage', async () => {
    const store = fakeBranding();
    const service = serviceFor([CLIENT_ORG], store);
    // `member` holds client_projection.read but not client_member.manage; the scope resolves, authorize denies.
    await expect(
      service.save(context, withRole('internal', 'member', null), CLIENT_ORG, VALID_SAVE),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.saved).toHaveLength(0);
  });

  it('answers 404 when a client reads a scope that is not their own', async () => {
    const store = fakeBranding();
    const service = serviceFor([CLIENT_ORG, OTHER_CLIENT_ORG], store);
    await expect(
      service.getForClient(
        context,
        withRole('client', 'client_viewer', CLIENT_ORG),
        OTHER_CLIENT_ORG,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('portal branding body validation (x323)', () => {
  it('rejects a malformed accent colour with 400', () => {
    expect(() => parseSaveBody({ accentColor: 'red' })).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => parseSaveBody({ accentColor: '#12' })).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });

  it('rejects an oversize heading or text with 400', () => {
    expect(() => parseSaveBody({ welcomeHeading: 'a'.repeat(201) })).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => parseSaveBody({ welcomeText: 'a'.repeat(2001) })).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });

  it('accepts a #RGB or #RRGGBB accent and bounded copy, defaulting the rest', () => {
    expect(parseSaveBody({ accentColor: '#abc' })).toEqual({
      accentColor: '#abc',
      welcomeHeading: null,
      welcomeText: null,
    });
  });
});

describe('portal branding route capabilities (x323)', () => {
  const capabilityOf = (proto: object, key: string): unknown =>
    Reflect.getMetadata(REQUIRED_CAPABILITY, (proto as Record<string, unknown>)[key] as object);

  it('guards the staff write and read with client_member.manage', () => {
    expect(capabilityOf(PortalBrandingController.prototype, 'save')).toBe('client_member.manage');
    expect(capabilityOf(PortalBrandingController.prototype, 'get')).toBe('client_member.manage');
  });

  it('guards the client projection with client_projection.read', () => {
    expect(capabilityOf(PortalBrandingClientController.prototype, 'get')).toBe(
      'client_projection.read',
    );
  });
});
