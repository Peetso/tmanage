import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { SubscriptionRepository } from '../billing/subscription.repository.js';
import { FileSafetySettingsController } from './file-safety-settings.controller.js';
import { fileSafetySettingsFrom } from './file-safety-settings.js';
import { OrgSettingsController } from './org-settings.controller.js';
import type { OrgSettingsRepository } from './org-settings.repository.js';

/** 56-06 (R19-e) — Security → File safety over fakes with the real `authorize`. */
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
  const subscriptions = {
    find: () => Promise.resolve({ planId: 'free' }),
  } as unknown as SubscriptionRepository;
  const audit = {
    record: (_r: unknown, _c: unknown, input: { action: string; metadata: unknown }) => {
      audits.push({ action: input.action, metadata: input.metadata });
      return Promise.resolve({});
    },
  } as unknown as AuditService;
  const controller = new FileSafetySettingsController(
    database,
    audit,
    scanner,
    settings,
    subscriptions,
  );
  return { controller, generic: new OrgSettingsController(database, settings), stored, audits };
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

describe('56-06 file safety settings', () => {
  it('reads the defaults: every preset (archives on since FIX5), the plan cap, scanned-only with a scanner', async () => {
    const view = await build({ kind: 'engine' }).controller.read(context, principal('owner'));
    expect(view).toMatchObject({
      presets: ['documents', 'images', 'design', 'video', 'archives'],
      requireScanForClients: true,
      scannerPresent: true,
    });
    expect(view.maxFileBytes).toBeGreaterThan(0);
  });

  it('refuses scanned-only for clients with no scanner (409 scanner_missing, no write)', async () => {
    const t = build({ kind: 'none' });
    const error = await refusal(
      t.controller.update(context, principal('owner'), { requireScanForClients: true }),
    );
    expect([error.status, error.code]).toEqual([409, 'scanner_missing']);
    expect(t.stored.size).toBe(0);
    expect(t.audits).toHaveLength(0);
    // And without a scanner the stored default never takes effect.
    const effective = fileSafetySettingsFrom({
      presetsStored: undefined,
      requireStored: 'true',
      planId: 'free',
      scanner: { kind: 'none' },
    });
    expect(effective.requireScanForClients).toBe(false);
  });

  it('writes presets in catalog order and audits before/after', async () => {
    const t = build({ kind: 'engine' });
    const view = await t.controller.update(context, principal('owner'), {
      presets: ['archives', 'documents'],
      requireScanForClients: false,
    });
    expect(view.presets).toEqual(['documents', 'archives']);
    expect(t.stored.get('file_safety_presets')).toBe('documents,archives');
    expect(t.audits).toEqual([
      {
        action: 'org.file_safety_changed',
        metadata: {
          presets_before: ['documents', 'images', 'design', 'video', 'archives'],
          presets_after: ['documents', 'archives'],
          require_scan_before: true,
          require_scan_after: false,
        },
      },
    ]);
  });

  it('refuses a bad body, a role without org.security.manage, and the generic PUT', async () => {
    const t = build({ kind: 'engine' });
    expect((await refusal(t.controller.update(context, principal('owner'), {}))).status).toBe(400);
    expect(
      (await refusal(t.controller.update(context, principal('owner'), { presets: ['exe'] })))
        .status,
    ).toBe(400);
    expect((await refusal(t.controller.read(context, principal('member')))).status).toBe(403);
    for (const key of ['file_safety_presets', 'require_scan_for_clients']) {
      const error = await refusal(t.generic.set(context, principal('owner'), key, { value: 'x' }));
      expect(error.status).toBe(403);
    }
    expect(t.stored.size).toBe(0);
  });
});
