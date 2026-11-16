import { hasCapability, isInternalRole } from '@tmanage/domain';
import type { OutboxEventPayloads } from '@tmanage/domain';

type RootAtRisk = OutboxEventPayloads['storage_connection.root_at_risk.v1'];
type StorageRootRiskReason = RootAtRisk['reason'];

/**
 * 51-17 slice 2 — the weekly owner check of the company's storage root.
 *
 * A Google Drive or OneDrive connection keeps the company's files in the connected account. Two
 * situations put those files at risk: the root sits in one person's own drive (`personal`), or the
 * person who connected it is no longer an active admin of the workspace (left, suspended or
 * demoted) — when their account is removed at Google or Microsoft, the files go with it. For each
 * live connection in one of those states this announces `storage_connection.root_at_risk.v1`;
 * its consumer tells the workspace owners in the inbox and by e-mail.
 *
 * At most once a week per connection: the store lists a connection only when no such event was
 * written for it in the last {@link STORAGE_ROOT_CHECK_DAYS} days (an offboarding announcement
 * counts too), and the event's key carries the week, so the owner's notice dedupes on it as well.
 * Nothing is changed on the connection; files keep working until someone hands the root over.
 */

export const STORAGE_ROOT_CHECK_DAYS = 7;
export const MAX_STORAGE_ROOT_CHECKS_PER_RUN = 500;

export interface StorageRootCandidate {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly provider: 'google_drive' | 'onedrive';
  /** `storage_connections.root_owner_kind` (0356). */
  readonly rootOwnerKind: string;
  /** The connecting person's membership, or null when they have none left in this workspace. */
  readonly holder: { readonly role: string; readonly status: string } | null;
}

export interface StorageRootCheckStore {
  /** Live connections with no at-risk event since `since`, at most {@link MAX_STORAGE_ROOT_CHECKS_PER_RUN}. */
  listCandidates(since: Date): Promise<readonly StorageRootCandidate[]>;
  announce(payload: RootAtRisk): Promise<void>;
}

/** Whether a role may hold the company's storage: the same rule as the API's hand-over check. */
export function mayHoldStorage(role: string): boolean {
  return (
    isInternalRole(role) &&
    hasCapability(role, 'org.manage') &&
    hasCapability(role, 'org.security.manage')
  );
}

/** Why this root is at risk, or null when it is not. A lost holder outranks a personal root. */
export function storageRootRisk(candidate: StorageRootCandidate): StorageRootRiskReason | null {
  const holder = candidate.holder;
  if (holder === null || holder.status !== 'active' || !mayHoldStorage(holder.role)) {
    return 'holder_not_admin';
  }
  if (candidate.rootOwnerKind === 'personal') return 'personal_root';
  return null;
}

/** The Monday (UTC) of `now`'s week, as `YYYY-MM-DD` — the week in the event's key. */
export function weekOf(now: Date): string {
  const day = (now.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day),
  );
  return monday.toISOString().slice(0, 10);
}

export interface StorageRootCheckResult {
  readonly checked: number;
  readonly announced: number;
}

export async function sweepStorageRootCheck(
  store: StorageRootCheckStore,
  now: Date = new Date(),
): Promise<StorageRootCheckResult> {
  const since = new Date(now.getTime() - STORAGE_ROOT_CHECK_DAYS * 86_400_000);
  const candidates = await store.listCandidates(since);
  const week = weekOf(now);
  let announced = 0;
  for (const candidate of candidates) {
    const reason = storageRootRisk(candidate);
    if (reason === null) continue;
    await store.announce({
      organizationId: candidate.organizationId,
      connectionId: candidate.connectionId,
      provider: candidate.provider,
      reason,
      idempotencyKey: `${candidate.connectionId}:${reason}:${week}`,
      occurredAt: now.toISOString(),
    });
    announced += 1;
  }
  return { checked: candidates.length, announced };
}
