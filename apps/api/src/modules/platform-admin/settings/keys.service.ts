import { uuidv7 } from '@tmanage/domain';
import { FIELD_CIPHER_PURPOSES } from '@tmanage/domain/field-cipher';
import type { FieldCipherKeyring, FieldCipherPurpose } from '@tmanage/domain/field-cipher';
import { ApiError } from '../../../common/http/errors.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import type { KeysStore, RotationStatus, StoredRotation } from './keys.repository.js';

/**
 * 56-02 · Platform admin → Settings → Keys: **status only**. Key ids present, the active key per
 * purpose, the rotation ledger and its progress — never a key value (they live only in the server
 * environment, `FIELD_CIPHER_KEYS`). Rotating queues a `key_rotations` row the worker re-encrypts
 * in 500-row batches; the new key must already be in env, so there is no key-entry route at all.
 */

/** The purposes the worker's re-encrypt job walks (`apps/worker/src/jobs/field-cipher-rotation.ts`). */
export const ROTATABLE_PURPOSES: readonly FieldCipherPurpose[] = [
  'storage_token',
  'calendar_token',
  'reporter_email',
  'org_secret',
  // 56-03p: the token vault's connector credentials and Figma tokens.
  'connector_token',
  'figma_token',
  // LANE-Q: the walkthrough visitor's and the outreach recipient's addresses.
  'walkthrough_email',
  'outreach_email',
];

/** Quarterly schedule (56-02 runbook): next rotation due three months after the last one. */
export const ROTATION_INTERVAL_MONTHS = 3;

export interface KeyRotationView {
  readonly id: string;
  readonly purpose: string;
  readonly fromKeyId: string | null;
  readonly toKeyId: string;
  readonly status: RotationStatus;
  readonly rowsTotal: number;
  /** Done + skipped + failed — the rows the job has walked. */
  readonly rowsProcessed: number;
  readonly rowsFailed: number;
  readonly createdAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface KeyPurposeView {
  readonly purpose: FieldCipherPurpose;
  readonly activeKeyId: string | null;
  readonly keysInRing: number;
  /** Rows still on an older key, or `null` when no rotation has measured it yet. */
  readonly rowsOnOldKey: number | null;
  readonly lastRotationAt: string | null;
  readonly rotatable: boolean;
  /** The queued or running rotation for this purpose. */
  readonly rotation: KeyRotationView | null;
}

export interface PlatformKeysView {
  readonly enabled: boolean;
  readonly activeKeyId: string | null;
  /** Key ids only — never a value. */
  readonly keyIds: readonly string[];
  readonly mfaFallback: boolean;
  readonly purposes: readonly KeyPurposeView[];
  /** The newest queued or running rotation, for the "Rotation in progress" card. */
  readonly rotation: KeyRotationView | null;
  readonly lastRotationAt: string | null;
  readonly nextRotationDueAt: string | null;
  readonly sessions: { readonly keysInRing: number; readonly overlap: boolean };
}

export interface KeysEnvironment {
  /** `FIELD_CIPHER_KEYS`, parsed; `null` when unset (FieldCipher disabled). */
  readonly keyring: FieldCipherKeyring | null;
  /** The MFA fallback ring (`AUTH_MFA_SEED_KEYS`), used only while `keyring` is unset. */
  readonly mfaFallback: FieldCipherKeyring | null;
  /** Whether `SESSION_SECRET_PREVIOUS` is set (24 h overlap after a session-secret rotation). */
  readonly sessionOverlap: boolean;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function sortedIds(ring: FieldCipherKeyring | null): string[] {
  return ring === null ? [] : [...ring.byId.keys()].sort((a, b) => Number(a) - Number(b));
}

export function rotationView(row: StoredRotation): KeyRotationView {
  return {
    id: row.id,
    purpose: row.purpose,
    fromKeyId: row.fromKeyId,
    toKeyId: row.toKeyId,
    status: row.status,
    rowsTotal: row.rowsTotal,
    rowsProcessed: row.rowsDone + row.rowsSkipped + row.rowsFailed,
    rowsFailed: row.rowsFailed,
    createdAt: iso(row.createdAt),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
  };
}

/** `at` plus whole months, clamped to the month's last day. */
export function addMonths(at: Date, months: number): Date {
  const out = new Date(at.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

/** Build the status view from the environment and the ledger (newest first). Pure. */
export function keysView(
  env: KeysEnvironment,
  ledger: readonly StoredRotation[],
): PlatformKeysView {
  const purposes = FIELD_CIPHER_PURPOSES.map((purpose): KeyPurposeView => {
    const ring = env.keyring ?? (purpose === 'mfa' ? env.mfaFallback : null);
    const keysInRing = ring === null ? 0 : ring.byId.size;
    const activeKeyId = ring?.active.id ?? null;
    const mine = ledger.filter((row) => row.purpose === purpose);
    const open = mine.find((row) => row.status === 'queued' || row.status === 'running') ?? null;
    const lastDone = mine.find((row) => row.status === 'done') ?? null;
    let rowsOnOldKey: number | null = null;
    if (open !== null) {
      rowsOnOldKey = Math.max(
        0,
        open.rowsTotal - open.rowsDone - open.rowsSkipped - open.rowsFailed,
      );
    } else if (keysInRing <= 1) {
      rowsOnOldKey = 0;
    } else if (lastDone !== null && lastDone.toKeyId === activeKeyId) {
      rowsOnOldKey = lastDone.rowsFailed;
    }
    return {
      purpose,
      activeKeyId,
      keysInRing,
      rowsOnOldKey,
      lastRotationAt: iso(lastDone?.finishedAt ?? null),
      rotatable: ROTATABLE_PURPOSES.includes(purpose),
      rotation: open === null ? null : rotationView(open),
    };
  });
  const open = ledger.find((row) => row.status === 'queued' || row.status === 'running') ?? null;
  const last = ledger
    .filter((row) => row.status === 'done' && row.finishedAt !== null)
    .map((row) => row.finishedAt as Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    enabled: env.keyring !== null,
    activeKeyId: env.keyring?.active.id ?? null,
    keyIds: sortedIds(env.keyring),
    mfaFallback: env.keyring === null && env.mfaFallback !== null,
    purposes,
    rotation: open === null ? null : rotationView(open),
    lastRotationAt: iso(last ?? null),
    nextRotationDueAt:
      last === undefined ? null : addMonths(last, ROTATION_INTERVAL_MONTHS).toISOString(),
    sessions: { keysInRing: env.sessionOverlap ? 2 : 1, overlap: env.sessionOverlap },
  };
}

export class PlatformKeysService {
  constructor(
    private readonly store: KeysStore,
    private readonly env: KeysEnvironment,
  ) {}

  async status(context: RequestContext): Promise<PlatformKeysView> {
    return keysView(this.env, await this.store.rotations(context.correlationId));
  }

  /**
   * `POST keys/rotate {purpose}` — super admin only (step-up is the guard's). Queues the worker's
   * re-encrypt job onto the newest key already in env; refuses when there is nothing to move to.
   */
  async rotate(
    actor: PlatformAdminActor,
    body: Readonly<Record<string, unknown>>,
    context: RequestContext,
  ): Promise<PlatformKeysView> {
    if (actor.preset !== undefined && actor.preset !== 'super_admin') {
      throw new ApiError(403, 'forbidden', 'Only a super admin can rotate keys.');
    }
    const purpose = body['purpose'];
    if (
      typeof purpose !== 'string' ||
      !(ROTATABLE_PURPOSES as readonly string[]).includes(purpose)
    ) {
      throw new ApiError(400, 'validation_failed', 'Choose a purpose that can be rotated.', [
        { field: 'purpose', message: `one of ${ROTATABLE_PURPOSES.join(', ')}` },
      ]);
    }
    const ring = this.env.keyring;
    if (ring === null) {
      throw new ApiError(409, 'conflict', 'No keys are set in the server environment.', [
        { field: 'purpose', message: 'keys_not_configured' },
      ]);
    }
    if (ring.byId.size < 2) {
      throw new ApiError(409, 'conflict', 'Add the new key in the server environment first.', [
        { field: 'purpose', message: 'no_new_key' },
      ]);
    }
    const previous = sortedIds(ring).filter((id) => id !== ring.active.id);
    const fromKeyId = previous[previous.length - 1] ?? null;
    const id = uuidv7();
    const queued = await this.store.queue(
      { id, purpose, fromKeyId, toKeyId: ring.active.id, requestedBy: actor.account.userId },
      platformAuditFor(actor, context, {
        action: 'platform.key_rotation_started',
        targetType: 'setting',
        targetId: id,
        targetLabel: purpose,
        reason: null,
        afterJson: JSON.stringify({ purpose, fromKeyId, toKeyId: ring.active.id }),
      }),
    );
    if (!queued) {
      throw new ApiError(409, 'conflict', 'A rotation for this purpose is running.', [
        { field: 'purpose', message: 'rotation_in_progress' },
      ]);
    }
    return this.status(context);
  }
}
