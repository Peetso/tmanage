import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { DownloadScanPolicyController } from './download-scan-policy.controller.js';
import { effectiveDownloadsBeforeScan } from './download-scan-policy.js';
import { OrgSettingsController } from './org-settings.controller.js';
import type { OrgSettingsRepository } from './org-settings.repository.js';

/**
 * B3 — the owner-only "downloads before a virus scan" route, over fakes with the real `authorize`.
 * Owner may set it (audited); org_admin and every other role is a 403 with no write; the generic
 * settings PUT never writes the key; without a scanner the effective value is `allow_labeled`.
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
  let upserts = 0;
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
      upserts += 1;
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
  const controller = new DownloadScanPolicyController(database, audit, scanner, settings);
  const generic = new OrgSettingsController(database, settings);
  return { controller, generic, stored, audits, upserts: () => upserts };
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

describe('B3 downloads-before-scan policy route', () => {
  it('reads allow_labeled by default', async () => {
    const t = build({ kind: 'engine' });
    await expect(t.controller.read(context, principal('owner'))).resolves.toEqual({
      downloadsBeforeScan: 'allow_labeled',
      effective: 'allow_labeled',
      scannerConfigured: true,
    });
  });

  it('lets the owner set block, and audits previous and new value', async () => {
    const t = build({ kind: 'engine' });
    const view = await t.controller.update(context, principal('owner'), {
      downloadsBeforeScan: 'block',
    });
    expect(view).toEqual({
      downloadsBeforeScan: 'block',
      effective: 'block',
      scannerConfigured: true,
    });
    expect(t.stored.get('downloads_before_scan')).toBe('block');
    expect(t.audits).toEqual([
      {
        action: 'organization.download_scan_policy_changed',
        metadata: { previous: 'allow_labeled', value: 'block' },
      },
    ]);
  });

  it('refuses org_admin and other roles with 403 and no write', async () => {
    for (const role of ['org_admin', 'workspace_admin', 'manager', 'member']) {
      const t = build({ kind: 'engine' });
      const error = await refusal(
        t.controller.update(context, principal(role), { downloadsBeforeScan: 'block' }),
      );
      expect(error.status).toBe(403);
      expect(t.upserts()).toBe(0);
      expect(t.audits).toEqual([]);
    }
  });

  it('refuses a value outside allow_labeled | block with 400', async () => {
    const t = build({ kind: 'engine' });
    for (const value of ['allow', 42, undefined]) {
      const error = await refusal(
        t.controller.update(context, principal('owner'), { downloadsBeforeScan: value }),
      );
      expect(error.status).toBe(400);
    }
    expect(t.upserts()).toBe(0);
  });

  it('without a scanner the effective value is allow_labeled whatever is stored', async () => {
    const t = build({ kind: 'none' });
    const view = await t.controller.update(context, principal('owner'), {
      downloadsBeforeScan: 'block',
    });
    expect(view).toEqual({
      downloadsBeforeScan: 'block',
      effective: 'allow_labeled',
      scannerConfigured: false,
    });
    expect(effectiveDownloadsBeforeScan('block', false)).toBe('allow_labeled');
  });

  it('the generic settings PUT never writes the owner-only key, even for the owner', async () => {
    for (const role of ['owner', 'org_admin']) {
      const t = build({ kind: 'engine' });
      const error = await refusal(
        t.generic.set(context, principal(role), 'downloads_before_scan', { value: 'block' }),
      );
      expect(error.status).toBe(403);
      expect(t.upserts()).toBe(0);
    }
  });

  it('both routes sit behind org.manage', () => {
    const proto = DownloadScanPolicyController.prototype;
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, proto.read)).toBe('org.manage');
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, proto.update)).toBe('org.manage');
  });
});
