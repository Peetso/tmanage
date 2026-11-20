/**
 * 56-02: the FieldCipher re-encrypt job. A rotation row in `key_rotations` (0249) names a purpose
 * and the key it must end on; this job walks that purpose's column in {@link ROTATION_BATCH}-row
 * batches (ordered by id), re-encrypts every `fc1.` envelope still on an older key, and saves the
 * resume point and counts after each batch — so a worker killed mid-run leaves a `running` row
 * whose heartbeat goes stale, and the next run carries on from `last_row_id`.
 *
 * - The target key must already be the cipher's newest (it is in env before the job is queued).
 * - Values that are not `fc1.` envelopes (legacy `mfa1.` rows, a writer not yet on FieldCipher)
 *   are counted `skipped` and left untouched: rewriting them would break their current reader.
 *   The token vault's legacy rows move to `fc1.` with `pnpm --filter @tmanage/api token-vault:upgrade`.
 * - A row that fails to open (unknown key, tampered) is counted `failed`; the job goes on.
 * - The write is a compare-and-swap on the old value, so a concurrent writer always wins.
 * - Logged by purpose with counts only, never a value (56-02 STRIDE "R").
 *
 * The MFA purpose is not here: the worker holds no grant on `user_mfa_factors` (grants.test.ts),
 * and MFA seeds rotate through the API's `mfa:encrypt-seeds` backfill.
 */

export const ROTATION_BATCH = 500;
export const ROTATION_INTERVAL_MS = 60_000;
/** A `running` rotation with no heartbeat for this long is resumed by the next worker. */
export const ROTATION_STALE_MS = 5 * 60 * 1000;

/**
 * Where a rotatable purpose lives. `owner` is the SQL (a column, or a `concat` of the row's own
 * columns) that rebuilds the AAD owner exactly as the writer bound it; `versionColumn`, when set,
 * is stamped with the key id the value was re-encrypted under (R23-c).
 */
export interface RotationTarget {
  readonly table: string;
  readonly column: string;
  readonly owner: string;
  readonly versionColumn?: string;
}

/** Where each rotatable purpose lives. */
export const ROTATION_TARGETS = {
  /**
   * 56-03p: the token vault (`apps/api/src/modules/connectors/token-vault.ts`) binds each token to
   * its writer's string, not the row id: `tokenBinding` (Drive, OneDrive), `calendarTokenBinding`
   * and `microsoftCalendarTokenBinding`, `connectorBinding`, `figmaTokenBinding`.
   */
  storage_token: {
    table: 'storage_connections',
    column: 'refresh_token_enc',
    owner: "concat('storage:', organization_id, ':', provider)",
  },
  calendar_token: {
    table: 'calendar_connections',
    column: 'refresh_token_enc',
    owner: "concat('calendar:', organization_id, ':', user_id, ':', provider)",
  },
  connector_token: {
    table: 'connector_installations',
    column: 'credential_enc',
    owner: "concat('connector:', organization_id, ':', connector_key)",
  },
  figma_token: {
    table: 'figma_connections',
    column: 'token_ciphertext',
    owner: "concat('figma:', organization_id, ':', membership_id)",
  },
  /** 56-17 follow-up: the writer is `security-reports.service.ts` (purpose `reporter_email`, owner = row id). */
  reporter_email: {
    table: 'security_reports',
    column: 'reporter_email_enc',
    owner: 'id',
  },
  /** LANE-Q 0388: the writer is `walkthrough.service.ts` (purpose `walkthrough_email`, owner = row id). */
  walkthrough_email: {
    table: 'walkthrough_requests',
    column: 'email_enc',
    owner: 'id',
  },
  /** 52-12 (R22-a): the writer is `einvoicing-certificate.controller.ts` (purpose `org_secret`, owner = row id). */
  /** R23-c: `key_version` is stamped with the new key id, so the platform keys page stays true. */
  org_secret: {
    table: 'org_secrets',
    column: 'ciphertext',
    owner: 'id',
    versionColumn: 'key_version',
  },
} as const satisfies Record<string, RotationTarget>;
export type RotationPurpose = keyof typeof ROTATION_TARGETS;

export function isRotationPurpose(value: string): value is RotationPurpose {
  return Object.hasOwn(ROTATION_TARGETS, value);
}

/** The slice of `@tmanage/domain/field-cipher`'s FieldCipher this job uses. */
export interface RotationCipher {
  activeKeyId(purpose: RotationPurpose): string | null;
  isEnvelope(value: string): boolean;
  rotate(envelope: string, aad: { purpose: RotationPurpose; ownerId: string }): string | null;
}

export interface ClaimedRotation {
  readonly id: string;
  readonly purpose: string;
  readonly toKeyId: string;
  readonly lastRowId: string | null;
  readonly counts: RotationCounts;
}

export interface RotationCounts {
  readonly done: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface SecretRow {
  readonly id: string;
  readonly ownerId: string;
  readonly value: string;
}

/** The statements the job needs. Faked by the unit test. */
export interface RotationStore {
  /** Claim the oldest queued rotation, or a running one whose heartbeat is stale. */
  claimNext(staleMs: number): Promise<ClaimedRotation | null>;
  /** Count the purpose's non-null values and stamp `rows_total` when the job is fresh. */
  countTotal(rotationId: string, target: RotationTarget): Promise<void>;
  readBatch(target: RotationTarget, afterId: string | null, limit: number): Promise<SecretRow[]>;
  /**
   * Compare-and-swap; false when the row changed since it was read. A target with a
   * `versionColumn` also gets `toKeyId` written there in the same statement.
   */
  writeValue(
    target: RotationTarget,
    id: string,
    from: string,
    to: string,
    toKeyId: string,
  ): Promise<boolean>;
  saveProgress(rotationId: string, lastRowId: string, counts: RotationCounts): Promise<void>;
  finish(rotationId: string, status: 'done' | 'failed', error: string | null): Promise<void>;
  /** Back to `queued`, keeping `last_row_id` and the counts, so the next run resumes at once. */
  pause(rotationId: string): Promise<void>;
}

export interface RotationRunResult {
  readonly rotationId: string | null;
  readonly status: 'idle' | 'done' | 'failed' | 'paused';
  readonly counts: RotationCounts;
}

const IDLE: RotationRunResult = {
  rotationId: null,
  status: 'idle',
  counts: { done: 0, skipped: 0, failed: 0 },
};

/** Run (or resume) one rotation, for at most `maxBatches` batches; `paused` means more remain. */
export async function runKeyRotation(deps: {
  readonly store: RotationStore;
  readonly cipher: RotationCipher;
  readonly maxBatches?: number;
  readonly log?: (line: string) => void;
}): Promise<RotationRunResult> {
  const { store, cipher } = deps;
  const log = deps.log ?? (() => undefined);
  const job = await store.claimNext(ROTATION_STALE_MS);
  if (job === null) return IDLE;

  const fail = async (error: string): Promise<RotationRunResult> => {
    await store.finish(job.id, 'failed', error);
    log(`key rotation ${job.id} (${job.purpose}) failed: ${error}`);
    return { rotationId: job.id, status: 'failed', counts: job.counts };
  };
  if (!isRotationPurpose(job.purpose)) return fail(`"${job.purpose}" is not a rotatable purpose`);
  const purpose = job.purpose;
  if (cipher.activeKeyId(purpose) !== job.toKeyId) {
    return fail(`key ${job.toKeyId} is not the newest key in FIELD_CIPHER_KEYS; add it and deploy`);
  }
  const target: RotationTarget = ROTATION_TARGETS[purpose];
  if (job.lastRowId === null) await store.countTotal(job.id, target);

  let { done, skipped, failed } = job.counts;
  let cursor = job.lastRowId;
  for (let batch = 0; batch < (deps.maxBatches ?? Number.POSITIVE_INFINITY); batch += 1) {
    const rows = await store.readBatch(target, cursor, ROTATION_BATCH);
    if (rows.length === 0) {
      await store.finish(job.id, 'done', null);
      log(
        `key rotation ${job.id} (${purpose}) done: ${done} rotated, ${skipped} skipped, ${failed} failed`,
      );
      return { rotationId: job.id, status: 'done', counts: { done, skipped, failed } };
    }
    for (const row of rows) {
      if (!cipher.isEnvelope(row.value)) {
        skipped += 1;
        continue;
      }
      try {
        const next = cipher.rotate(row.value, { purpose, ownerId: row.ownerId });
        if (next !== null) await store.writeValue(target, row.id, row.value, next, job.toKeyId);
        done += 1;
      } catch {
        failed += 1;
      }
    }
    cursor = (rows[rows.length - 1] as SecretRow).id;
    await store.saveProgress(job.id, cursor, { done, skipped, failed });
  }
  await store.pause(job.id);
  return { rotationId: job.id, status: 'paused', counts: { done, skipped, failed } };
}
