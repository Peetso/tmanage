import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { DOWNLOADS_BEFORE_SCAN_VALUES, defaultFor } from './org-settings.allowlist.js';
import type { DownloadsBeforeScan } from './org-settings.allowlist.js';
import { OrgSettingsRepository } from './org-settings.repository.js';

/**
 * B3 — "Downloads before a virus scan", the company owner's choice.
 *
 * The stored value lives in `org_settings` under `downloads_before_scan` (the A11 key/value table;
 * no column, no migration). What a download does is the **effective** value:
 *
 * - no scanner configured (`MALWARE_SCAN_DRIVER=none`): always `allow_labeled`, whatever is stored —
 *   a `block` there would make every file in the company unreachable forever, because no scan
 *   result will ever arrive;
 * - a scanner configured: the stored value, or the default `allow_labeled` when none was written.
 *
 * Infected / rejected files are never governed by this: they are refused whatever the policy says.
 */
export const DOWNLOADS_BEFORE_SCAN_KEY = 'downloads_before_scan' as const;

/** The minimal scanner fact the policy needs: whether an engine actually scans. */
export interface ScannerPresence {
  readonly kind: 'none' | 'engine';
}

/** Whether a deployment has a real scanner. The `none` driver scans nothing. */
export function scannerConfigured(scanner: ScannerPresence | undefined): boolean {
  return scanner !== undefined && scanner.kind === 'engine';
}

/** The stored value read back as a policy; anything unrecognised falls back to the default. */
export function storedDownloadsBeforeScan(stored: string | undefined): DownloadsBeforeScan {
  const value = stored ?? defaultFor(DOWNLOADS_BEFORE_SCAN_KEY);
  return (DOWNLOADS_BEFORE_SCAN_VALUES as readonly string[]).includes(value)
    ? (value as DownloadsBeforeScan)
    : (defaultFor(DOWNLOADS_BEFORE_SCAN_KEY) as DownloadsBeforeScan);
}

/** The value a download obeys. Without a scanner it is `allow_labeled`, whatever is stored. */
export function effectiveDownloadsBeforeScan(
  stored: DownloadsBeforeScan,
  hasScanner: boolean,
): DownloadsBeforeScan {
  return hasScanner ? stored : 'allow_labeled';
}

/** Read the stored and effective policy for the acting organization. */
export async function readDownloadScanPolicy(
  database: TenantDatabase,
  context: TenantContext,
  scanner: ScannerPresence | undefined,
  repository: OrgSettingsRepository = new OrgSettingsRepository(),
): Promise<{
  readonly stored: DownloadsBeforeScan;
  readonly effective: DownloadsBeforeScan;
  readonly scannerConfigured: boolean;
}> {
  const row = await database.read(context, (runner) =>
    repository.findByKey(runner, context, DOWNLOADS_BEFORE_SCAN_KEY),
  );
  const stored = storedDownloadsBeforeScan(row?.settingValue);
  const hasScanner = scannerConfigured(scanner);
  return {
    stored,
    effective: effectiveDownloadsBeforeScan(stored, hasScanner),
    scannerConfigured: hasScanner,
  };
}

/**
 * FIX4 item 1b. The effective policy read on a runner the caller already holds (inside its own
 * transaction), for the doors that decide whether a not-yet-scanned file may be used now.
 */
export async function effectiveDownloadScanPolicyOn(
  runner: TenantQueryRunner,
  context: TenantContext,
  scanner: ScannerPresence | undefined,
  repository: OrgSettingsRepository = new OrgSettingsRepository(),
): Promise<DownloadsBeforeScan> {
  const row = await repository.findByKey(runner, context, DOWNLOADS_BEFORE_SCAN_KEY);
  return effectiveDownloadsBeforeScan(
    storedDownloadsBeforeScan(row?.settingValue),
    scannerConfigured(scanner),
  );
}
