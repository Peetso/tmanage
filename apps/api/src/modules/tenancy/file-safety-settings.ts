import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { entitlementsFor } from '../billing/billing-mode.js';
import { readPlanId } from '../billing/plan-catalog.js';
import { SubscriptionRepository } from '../billing/subscription.repository.js';
import { parsePresets, planMaxFileBytes } from '../files/file-safety.js';
import type { FileTypePreset } from '../files/file-safety.js';
import { scannerConfigured } from './download-scan-policy.js';
import type { ScannerPresence } from './download-scan-policy.js';
import { defaultFor } from './org-settings.allowlist.js';
import { OrgSettingsRepository } from './org-settings.repository.js';

/**
 * 56-06 (R19-e) — an organization's file-safety settings, read in one place for the settings
 * route, the upload door and the download gate.
 *
 * - `presets`: the stored `file_safety_presets` csv, or every preset but archives.
 * - `maxFileBytes`: the plan's per-file cap (the entitled plan: the top one during the free beta),
 *   never above the contract's 5 GiB. Read-only — a plan change moves it.
 * - `requireScanForClients`: the **effective** value. Stored `true` (the default) counts only
 *   while a scanner is configured; without one no verdict would ever arrive and every client file
 *   would be unreachable — the same reasoning `downloads_before_scan` follows.
 */
export const FILE_SAFETY_PRESETS_KEY = 'file_safety_presets' as const;
export const REQUIRE_SCAN_FOR_CLIENTS_KEY = 'require_scan_for_clients' as const;

export interface FileSafetySettings {
  readonly presets: readonly FileTypePreset[];
  readonly maxFileBytes: number;
  /** What a client download obeys. */
  readonly requireScanForClients: boolean;
  /** What the owner stored (or the default), before the scanner check. */
  readonly requireScanForClientsStored: boolean;
  readonly scannerPresent: boolean;
}

/**
 * The stored `require_scan_for_clients` read as on/off: `'false'` is off, `'true'` is on, and a
 * missing or unrecognised value is the allowlist default (on).
 */
export function requireScanStoredOn(stored: string | undefined): boolean {
  const value = stored ?? defaultFor(REQUIRE_SCAN_FOR_CLIENTS_KEY);
  if (value === 'false') return false;
  if (value === 'true') return true;
  return defaultFor(REQUIRE_SCAN_FOR_CLIENTS_KEY) === 'true';
}

/** What the upload door and the download gate ask for; `FilesService` takes it optionally. */
export interface FileSafetySettingsSource {
  read(context: TenantContext): Promise<FileSafetySettings>;
}

/** Compose the view from stored values. Pure, so the rule is unit-tested without a database. */
export function fileSafetySettingsFrom(input: {
  readonly presetsStored: string | undefined;
  readonly requireStored: string | undefined;
  readonly planId: string | null | undefined;
  readonly scanner: ScannerPresence | undefined;
}): FileSafetySettings {
  const scannerPresent = scannerConfigured(input.scanner);
  const stored = requireScanStoredOn(input.requireStored);
  return {
    presets: parsePresets(input.presetsStored),
    maxFileBytes: planMaxFileBytes(entitlementsFor(readPlanId(input.planId)).planId),
    requireScanForClients: stored && scannerPresent,
    requireScanForClientsStored: stored,
    scannerPresent,
  };
}

/** Read inside an open runner (a transaction that also writes, or a read). */
export async function readFileSafetySettingsWith(
  runner: TenantQueryRunner,
  context: TenantContext,
  scanner: ScannerPresence | undefined,
  settings: OrgSettingsRepository = new OrgSettingsRepository(),
  subscriptions: SubscriptionRepository = new SubscriptionRepository(),
): Promise<FileSafetySettings> {
  const presets = await settings.findByKey(runner, context, FILE_SAFETY_PRESETS_KEY);
  const require = await settings.findByKey(runner, context, REQUIRE_SCAN_FOR_CLIENTS_KEY);
  const subscription = await subscriptions.find(runner, context);
  return fileSafetySettingsFrom({
    presetsStored: presets?.settingValue,
    requireStored: require?.settingValue,
    planId: subscription?.planId,
    scanner,
  });
}

/** The injectable reader: one read transaction per call. */
export class FileSafetySettingsReader implements FileSafetySettingsSource {
  constructor(
    private readonly database: TenantDatabase,
    private readonly scanner: ScannerPresence | undefined,
    private readonly settings: OrgSettingsRepository = new OrgSettingsRepository(),
    private readonly subscriptions: SubscriptionRepository = new SubscriptionRepository(),
  ) {}

  read(context: TenantContext): Promise<FileSafetySettings> {
    return this.database.read(context, (runner) =>
      readFileSafetySettingsWith(runner, context, this.scanner, this.settings, this.subscriptions),
    );
  }
}
