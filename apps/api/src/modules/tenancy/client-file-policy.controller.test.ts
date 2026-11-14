import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { ClientFilePolicyController } from './client-file-policy.controller.js';
import { OrgSettingsController } from './org-settings.controller.js';
import type { OrgSettingsRepository } from './org-settings.repository.js';

/**
 * FIX6 item 1 — the owner-only "Files clients can receive" route, over fakes with the real
 * `authorize`. The default with no scanner is `checked`; the owner may choose either value
 * (audited); an org_admin and every other role is a 403 with no write; the generic settings PUT
 * never writes the key; `virus_scanned` with no scanner says nothing can be shared.
 */
const ORG = '00000000-0000-4000-8000-0000000000a1';
const context = { organizationId: ORG, membershipId: 'm' } as unknown as TenantContext;

function principal(role: string): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: '00000000-0000-4000-8000-0000000000e1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  } as Principal;
}

function build(scanner?: { readonly kind: 'none' | 'engine' }) {
  const stored = new Map<string, string>();
  const audits: { action: string; metadata: unknown }[] = [];
  const database = {
    read: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
    transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
  } as unknown as TenantDatabase;
  const settings = {
    resolveOrganization: () => Promise.resolve({ id: ORG }),
    listAll: () => Promise.resolve([]),
    findByKey: (_r: unknown, _c: unknown, key: string) =>
      Promise.resolve(stored.has(key) ? { settingValue: stored.get(key) } : undefined),
    upsert: (_r: unknown, _c: unknown, input: { key: string; value: string }) => {
      stored.set(input.key, input.value);
      return Promise.resolve();
    },
  } as unknown as OrgSettingsRepository;
  const audit = {
    record: (_r: unknown, _c: unknown, input: { action: string; metadata: unknown }) => {
      audits.push({ action: input.action, metadata: input.metadata });
      return Promise.resolve({});
    },
  } as unknown as AuditService;
  const controller = new ClientFilePolicyController(database, audit, scanner, settings);
  const generic = new OrgSettingsController(database, settings);
  return { controller, generic, stored, audits };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('FIX6 files clients can receive', () => {
  it('reads checked by default with no scanner, virus_scanned with one', async () => {
    await expect(
      build({ kind: 'none' }).controller.read(context, principal('owner')),
    ).resolves.toEqual({ clientFiles: 'checked', scannerConfigured: false, sharingPossible: true });
    await expect(
      build({ kind: 'engine' }).controller.read(context, principal('owner')),
    ).resolves.toEqual({
      clientFiles: 'virus_scanned',
      scannerConfigured: true,
      sharingPossible: true,
    });
  });

  it('the owner sets virus_scanned with no scanner: stored, audited, and nothing can be shared', async () => {
    const t = build({ kind: 'none' });
    const view = await t.controller.update(context, principal('owner'), {
      clientFiles: 'virus_scanned',
    });
    expect(view).toEqual({
      clientFiles: 'virus_scanned',
      scannerConfigured: false,
      sharingPossible: false,
    });
    expect(t.stored.get('require_scan_for_clients')).toBe('true');
    expect(t.audits).toEqual([
      {
        action: 'organization.client_file_policy_changed',
        metadata: { previous: 'checked', value: 'virus_scanned' },
      },
    ]);
  });

  it('an org_admin or a member is a 403 with no write; a bad value is a 400', async () => {
    const t = build({ kind: 'none' });
    for (const role of ['org_admin', 'member']) {
      const error = await refusal(
        t.controller.update(context, principal(role), { clientFiles: 'checked' }),
      );
      expect(error.status).toBe(403);
    }
    expect(
      (await refusal(t.controller.update(context, principal('owner'), { clientFiles: 'all' })))
        .status,
    ).toBe(400);
    expect(t.stored.size).toBe(0);
    expect(t.audits).toHaveLength(0);
  });

  it('the generic settings PUT never writes the key', async () => {
    const t = build({ kind: 'none' });
    const error = await refusal(
      t.generic.set(context, principal('owner'), 'require_scan_for_clients', { value: 'false' }),
    );
    expect(error.status).toBe(403);
    expect(t.stored.size).toBe(0);
  });
});
