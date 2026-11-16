import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PortalA11yPreferencesService } from './portal-a11y.service.js';
import type { A11yPreferencesRepository } from './a11y.repository.js';
import type { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { A11yPreferences, ClientA11yPreferenceRow } from '../../common/database/schema.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const ME = '00000000-0000-4000-8000-0000000000f1';
const OTHER = '00000000-0000-4000-8000-0000000000f2';

function client(membershipId: string, kind: Principal['kind'] = 'client'): Principal {
  return {
    userId: `user-${membershipId}`,
    organizationId: ORG,
    kind,
    role: kind === 'client' ? 'client_viewer' : 'member',
    membershipId,
    membershipStatus: 'active',
    clientOrganizationId: kind === 'client' ? '00000000-0000-4000-8000-0000000000b1' : null,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG } as unknown as TenantContext;

function serviceWith(rows: Map<string, A11yPreferences>): PortalA11yPreferencesService {
  const repo = {
    findForClientMembership: (_r: unknown, _c: unknown, id: string) => {
      const settings = rows.get(id);
      return Promise.resolve(settings ? ({ a11yJson: settings } as ClientA11yPreferenceRow) : null);
    },
    upsertForClientMembership: (_r: unknown, _c: unknown, id: string, s: A11yPreferences) => {
      rows.set(id, s);
      return Promise.resolve();
    },
  } as unknown as A11yPreferencesRepository;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new PortalA11yPreferencesService(database, repo);
}

const LARGE = { fontScale: 'xl', reduceMotion: true, highContrast: true } as const;

describe('PortalA11yPreferencesService (PORTALA11Y)', () => {
  it('saves a client’s own settings and reads them back; another client still reads defaults', async () => {
    const service = serviceWith(new Map());
    await service.replace(context, client(ME), LARGE);
    expect(await service.read(context, client(ME))).toEqual(LARGE);
    expect((await service.read(context, client(OTHER))).fontScale).toBe('md');
  });

  it('never writes another person’s row: a named membership is refused, and so is a non-client', async () => {
    const rows = new Map<string, A11yPreferences>();
    const service = serviceWith(rows);
    const named = await service
      .replace(context, client(ME), { ...LARGE, membershipId: OTHER })
      .catch((e: unknown) => e);
    expect((named as ApiError).status).toBe(400);
    const staff = await service.replace(context, client(OTHER, 'internal'), LARGE).catch((e) => e);
    expect((staff as ApiError).status).toBe(403);
    expect(rows.size).toBe(0);
  });
});
