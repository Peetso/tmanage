import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import {
  ORG_SETTING_KEYS,
  defaultFor,
  isSettingOn,
  validateDefaultLocale,
  validateValue,
} from './org-settings.allowlist.js';
import { requireOrgPermission } from './org-policy.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OrgSettingsRepository } from './org-settings.repository.js';

/** A11 — the four "What members can do" keys and the routes that read them. */

const A11_KEYS = [
  'members_can_create_projects',
  'members_can_invite_clients',
  'clients_can_upload_files',
  'require_two_step',
] as const;

function principal(overrides: Partial<Principal>): Principal {
  return {
    userId: 'u1',
    organizationId: 'o1',
    kind: 'internal',
    role: 'member',
    membershipId: 'm1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
    ...overrides,
  } as Principal;
}

const database = {
  read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;

/** A settings repository whose only stored row for any key is `stored` (or none). */
function repoWith(stored: string | undefined): OrgSettingsRepository {
  return {
    findByKey: () => Promise.resolve(stored === undefined ? undefined : { settingValue: stored }),
  } as unknown as OrgSettingsRepository;
}

const context = { organizationId: 'o1' } as unknown as TenantContext;

describe('org settings allowlist — A11 keys', () => {
  it('lists the four keys, defaulting the switches on and two-step off', () => {
    for (const key of A11_KEYS) expect(ORG_SETTING_KEYS).toContain(key);
    expect(defaultFor('members_can_create_projects')).toBe('true');
    expect(defaultFor('members_can_invite_clients')).toBe('true');
    expect(defaultFor('clients_can_upload_files')).toBe('true');
    expect(defaultFor('require_two_step')).toBe('false');
  });

  it('accepts only true/false, canonicalised', () => {
    expect(validateValue('require_two_step', ' TRUE ')).toEqual({ ok: true, value: 'true' });
    expect(validateValue('clients_can_upload_files', 'yes').ok).toBe(false);
  });

  it('reads a missing row as the default', () => {
    expect(isSettingOn('members_can_create_projects', undefined)).toBe(true);
    expect(isSettingOn('members_can_create_projects', 'false')).toBe(false);
    expect(isSettingOn('require_two_step', undefined)).toBe(false);
  });
});

describe('requireOrgPermission — the routes honour the switches', () => {
  it('refuses a manager creating a project when members may not (403)', async () => {
    const error = await requireOrgPermission(
      database,
      context,
      principal({ role: 'manager' }),
      'members_can_create_projects',
      repoWith('false'),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  });

  it('lets an admin through whatever the switch says, without reading it', async () => {
    const refusingDatabase = {
      read: () => Promise.reject(new Error('must not read')),
    } as unknown as TenantDatabase;
    await expect(
      requireOrgPermission(
        refusingDatabase,
        context,
        principal({ role: 'org_admin' }),
        'members_can_create_projects',
      ),
    ).resolves.toBeUndefined();
  });

  it('lets a project lead invite clients when members may not', async () => {
    await expect(
      requireOrgPermission(
        database,
        context,
        principal({ role: 'manager' }),
        'members_can_invite_clients',
        repoWith('false'),
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a client upload when clients may not upload, and allows it by default', async () => {
    const client = principal({ kind: 'client', role: 'client_member', clientOrganizationId: 'c1' });
    const refused = await requireOrgPermission(
      database,
      context,
      client,
      'clients_can_upload_files',
      repoWith('false'),
    ).catch((e: unknown) => e);
    expect((refused as ApiError).status).toBe(403);
    await expect(
      requireOrgPermission(
        database,
        context,
        client,
        'clients_can_upload_files',
        repoWith(undefined),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('R12 default_locale', () => {
  it('accepts the display allowlist and the legacy column values, nothing else', () => {
    expect(validateDefaultLocale(' zh-CN ')).toEqual({ ok: true, value: 'zh-CN' });
    expect(validateDefaultLocale('en').ok).toBe(true);
    expect(validateDefaultLocale('es').ok).toBe(false);
  });
});
