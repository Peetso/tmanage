import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { scannerConfigured } from './download-scan-policy.js';
import type { ScannerPresence } from './download-scan-policy.js';
import { OrgSettingsRepository } from './org-settings.repository.js';

/**
 * FIX6 item 1 — "Files clients can receive", the company owner's choice.
 *
 * - `checked`: a file that passed TManage's own safety checks (its type read from its content,
 *   blocked types refused, ZIP and Office files checked inside, size limits) may go to a client,
 *   labelled "Checked", before or without a virus scan.
 * - `virus_scanned`: only a file a virus scanner cleared may go to a client. Without a scanner no
 *   file is ever cleared, so nothing can be shared — the settings screen says so plainly.
 *
 * Stored under the existing `require_scan_for_clients` key (`'true'` = `virus_scanned`,
 * `'false'` = `checked`), so a company's earlier choice carries over. Nothing stored means
 * `virus_scanned` when a scanner is configured and `checked` when none is (live today): a company
 * with no scanner must still be able to send work to its clients.
 *
 * The owner's choice is obeyed as stored, scanner or not. Blocked, infected and refused files are
 * never shareable, whatever this says (`client-file-sharing.ts`).
 *
 * The org_settings key the policy is stored under (56-06's name, kept so choices carry over).
 */
export const REQUIRE_SCAN_FOR_CLIENTS_KEY = 'require_scan_for_clients' as const;

export const CLIENT_FILES_POLICIES = ['checked', 'virus_scanned'] as const;
export type ClientFilesPolicy = (typeof CLIENT_FILES_POLICIES)[number];

export function isClientFilesPolicy(value: unknown): value is ClientFilesPolicy {
  return typeof value === 'string' && (CLIENT_FILES_POLICIES as readonly string[]).includes(value);
}

/** The stored value read as a policy; nothing (or anything unrecognised) is the scanner default. */
export function clientFilesPolicyFrom(
  stored: string | undefined,
  hasScanner: boolean,
): ClientFilesPolicy {
  if (stored === 'true') return 'virus_scanned';
  if (stored === 'false') return 'checked';
  return hasScanner ? 'virus_scanned' : 'checked';
}

/** The stored form of a policy. */
export function storedClientFilesPolicy(policy: ClientFilesPolicy): 'true' | 'false' {
  return policy === 'virus_scanned' ? 'true' : 'false';
}

/** The policy read on a runner the caller already holds. */
export async function clientFilesPolicyOn(
  runner: TenantQueryRunner,
  context: TenantContext,
  scanner: ScannerPresence | undefined,
  settings: OrgSettingsRepository = new OrgSettingsRepository(),
): Promise<ClientFilesPolicy> {
  const row = await settings.findByKey(runner, context, REQUIRE_SCAN_FOR_CLIENTS_KEY);
  return clientFilesPolicyFrom(row?.settingValue, scannerConfigured(scanner));
}

/** The policy read in its own read transaction. */
export function readClientFilesPolicy(
  database: TenantDatabase,
  context: TenantContext,
  scanner: ScannerPresence | undefined,
  settings: OrgSettingsRepository = new OrgSettingsRepository(),
): Promise<ClientFilesPolicy> {
  return database.read(context, (runner) =>
    clientFilesPolicyOn(runner, context, scanner, settings),
  );
}
