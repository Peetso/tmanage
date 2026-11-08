import { describe, expect, it } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import type { Principal } from '@tmanage/domain';
import { createSeedCipher } from '../identity/seed-cipher.js';
import { ConnectorsService, connectorBinding } from './connectors.service.js';
import type { ConnectorsRepository } from './connectors.repository.js';
import type { ConnectorInstallationRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/** 54-01. The connector framework over fakes, with the real `authorize()` and the real vault. */

const ORG = 'organization-0000-0000-0000-000000000001';
const context = { organizationId: ORG, userId: 'user-1' } as unknown as TenantContext;
const CIPHER = createSeedCipher(parseSeedKeys(`1:${Buffer.alloc(32, 0x54).toString('base64url')}`));
const KEY = 'jira-token-abcd1234';

function principal(role: Principal['role']): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: role === 'owner',
  };
}

function build(storage: string[] = [], calendars: string[] = []) {
  const rows: ConnectorInstallationRow[] = [];
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    listInstalled: async () => rows,
    findByKey: async (_r: unknown, _c: unknown, key: string) =>
      rows.find((row) => row.connectorKey === key) ?? null,
    insert: async (
      _r: unknown,
      _c: unknown,
      input: { connectorKey: string; credentialEnc: string | null; credentialHint: string | null },
    ) => {
      rows.push({
        id: `row-${rows.length}`,
        organizationId: ORG,
        installedBy: 'user-1',
        installedAt: new Date('2026-11-08T10:00:00.000Z'),
        ...input,
      });
    },
    remove: async (_r: unknown, _c: unknown, key: string) => {
      const index = rows.findIndex((row) => row.connectorKey === key);
      if (index >= 0) rows.splice(index, 1);
    },
    connectedStorage: async () => storage,
    connectedCalendars: async () => calendars,
  } as unknown as ConnectorsRepository;
  return { service: new ConnectorsService(database, CIPHER, repository), rows };
}

describe('ConnectorsService (54-01)', () => {
  it('lists the registry, reusing Drive/OneDrive/calendar connections as connectors', async () => {
    const { service } = build(['google_drive'], ['microsoft']);
    const views = await service.list(context, principal('owner'));
    const state = Object.fromEntries(views.map((view) => [view.key, view.state]));
    expect(state).toMatchObject({
      google_drive: 'connected',
      onedrive: 'not_connected',
      google_calendar: 'not_connected',
      microsoft_calendar: 'connected',
      jira: 'not_installed',
    });
  });

  it('is owner/admin only', async () => {
    const { service } = build();
    await expect(service.list(context, principal('member'))).rejects.toMatchObject({ status: 403 });
    await expect(
      service.install(context, principal('member'), 'jira', { apiKey: KEY }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('stores the API key only as a vault envelope bound to the organization and connector', async () => {
    const { service, rows } = build();
    const view = await service.install(context, principal('owner'), 'jira', { apiKey: KEY });
    expect(view).toMatchObject({ state: 'installed', credentialHint: '1234' });
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(rows[0]?.credentialEnc).not.toContain(KEY);
    expect(CIPHER.decrypt(rows[0]?.credentialEnc ?? '', connectorBinding(ORG, 'jira'))).toBe(KEY);
    expect(await service.credential(context, 'jira')).toBe(KEY);
  });

  it('refuses a built-in, an unknown, a malformed key and a second install', async () => {
    const { service } = build();
    const owner = principal('owner');
    await expect(
      service.install(context, owner, 'google_drive', { apiKey: KEY }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(service.install(context, owner, 'nope', { apiKey: KEY })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.install(context, owner, 'jira', { apiKey: 'short' }),
    ).rejects.toMatchObject({ status: 422 });
    await service.install(context, owner, 'jira', { apiKey: KEY });
    await expect(service.install(context, owner, 'jira', { apiKey: KEY })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('uninstall drops the row and its credential', async () => {
    const { service, rows } = build();
    await service.install(context, principal('owner'), 'github', { apiKey: KEY });
    const view = await service.uninstall(context, principal('owner'), 'github');
    expect(view.state).toBe('not_installed');
    expect(rows).toHaveLength(0);
    expect(await service.credential(context, 'github')).toBeNull();
  });
});
