import { describe, expect, it } from 'vitest';
import type { FileAssetRow, FileVersionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { clientFilesPolicyFrom } from '../tenancy/client-file-policy.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import { ClientFileSharing, clientFileState } from './client-file-sharing.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { portalScanStatus } from './portal-file-list.service.js';

/**
 * FIX6 item 1 — the one rule that decides whether a file may reach a client. On live there is no
 * virus scanner, so before this every client road (which required `ready`) was closed for good.
 */
const version = (patch: Partial<FileVersionRow>): FileVersionRow =>
  ({
    detectedMimeType: 'application/pdf',
    scanVerdict: 'clean',
    trustZone: 'private',
    ...patch,
  }) as FileVersionRow;
const asset = (status: string, deletedAt: Date | null = null) => ({ status, deletedAt });
// A file the built-in checks passed and no scanner judged: what every upload on live is.
const checkedFile = version({ scanVerdict: 'unscanned', trustZone: 'quarantine' });

describe('clientFilesPolicyFrom', () => {
  it('defaults to checked with no scanner and to virus_scanned with one', () => {
    expect(clientFilesPolicyFrom(undefined, false)).toBe('checked');
    expect(clientFilesPolicyFrom(undefined, true)).toBe('virus_scanned');
  });

  it('obeys the stored choice, scanner or not', () => {
    expect(clientFilesPolicyFrom('true', false)).toBe('virus_scanned');
    expect(clientFilesPolicyFrom('false', true)).toBe('checked');
  });
});

describe('clientFileState', () => {
  it('a virus-scanned file reaches a client whatever the policy', () => {
    expect(clientFileState(asset('ready'), version({}), 'virus_scanned', 'block')).toBe(
      'virus_scanned',
    );
  });

  it('the default lets a checked file reach a client, labelled checked, never virus-scanned', () => {
    expect(clientFileState(asset('scanning'), checkedFile, 'checked', 'allow_labeled')).toBe(
      'checked',
    );
  });

  it('the strict policy refuses a checked file', () => {
    expect(
      clientFileState(asset('scanning'), checkedFile, 'virus_scanned', 'allow_labeled'),
    ).toBeNull();
  });

  it('the team policy "block until scanned" holds a checked file back from clients too', () => {
    expect(clientFileState(asset('scanning'), checkedFile, 'checked', 'block')).toBeNull();
  });

  it('a blocked, infected, unverified or deleted file is never shareable', () => {
    for (const policy of ['checked', 'virus_scanned'] as const) {
      expect(
        clientFileState(asset('rejected'), version({ scanVerdict: null }), policy, 'allow_labeled'),
      ).toBeNull();
      expect(
        clientFileState(
          asset('scanning'),
          version({ scanVerdict: 'infected' }),
          policy,
          'allow_labeled',
        ),
      ).toBeNull();
      expect(
        clientFileState(
          asset('scanning'),
          version({ detectedMimeType: null, scanVerdict: null }),
          policy,
          'allow_labeled',
        ),
      ).toBeNull();
      expect(
        clientFileState(asset('ready', new Date()), version({}), policy, 'allow_labeled'),
      ).toBeNull();
      expect(clientFileState(asset('scanning'), null, policy, 'allow_labeled')).toBeNull();
    }
  });
});

describe('portalScanStatus', () => {
  it('lists scanned as clean, checked as not_scanned, and hides what cannot be shared', () => {
    expect(portalScanStatus('virus_scanned', false, false)).toBe('clean');
    expect(portalScanStatus('checked', true, false)).toBe('not_scanned');
    // A scanner may still clear it: listed as being checked.
    expect(portalScanStatus(null, true, true)).toBe('being_checked');
    // No scanner and the owner keeps clients to scanned files: nothing to wait for, not listed.
    expect(portalScanStatus(null, true, false)).toBeNull();
    expect(portalScanStatus(null, false, true)).toBeNull();
  });
});

describe('ClientFileSharing.assertVersionFileShareable (the publish doors)', () => {
  const context = { organizationId: 'org' } as TenantContext;
  const runner = {} as TenantQueryRunner;

  function sharing(stored: string | undefined, scanner: 'none' | 'engine', status = 'scanning') {
    const settings = {
      findByKey: (_r: unknown, _c: unknown, key: string) =>
        Promise.resolve(
          key === 'require_scan_for_clients' && stored !== undefined
            ? { settingValue: stored }
            : undefined,
        ),
    } as unknown as OrgSettingsRepository;
    const assets = {
      findWithLatestVersion: () =>
        Promise.resolve({
          asset: { status, deletedAt: null } as FileAssetRow,
          version: checkedFile,
        }),
    } as unknown as FileAssetsRepository;
    return new ClientFileSharing({ kind: scanner }, settings, assets);
  }

  async function refusal(promise: Promise<void>): Promise<string | null> {
    try {
      await promise;
      return null;
    } catch (error) {
      if (error instanceof ApiError) return error.details?.[0]?.message ?? error.code;
      throw error;
    }
  }

  it('the default publishes a checked file; a note-only version always passes', async () => {
    await expect(
      sharing(undefined, 'none').assertVersionFileShareable(runner, context, 'f'),
    ).resolves.toBeUndefined();
    await expect(
      sharing('true', 'none').assertVersionFileShareable(runner, context, null),
    ).resolves.toBeUndefined();
  });

  it('strict with no scanner says plainly nothing can be sent', async () => {
    expect(
      await refusal(sharing('true', 'none').assertVersionFileShareable(runner, context, 'f')),
    ).toBe('scan_required');
  });

  it('strict with a scanner waits for the scan; a blocked file is refused under the default', async () => {
    expect(
      await refusal(sharing(undefined, 'engine').assertVersionFileShareable(runner, context, 'f')),
    ).toBe('not_shareable');
    expect(
      await refusal(
        sharing('false', 'none', 'rejected').assertVersionFileShareable(runner, context, 'f'),
      ),
    ).toBe('not_shareable');
  });
});
