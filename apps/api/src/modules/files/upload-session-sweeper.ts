import { uuidv7 } from '@tmanage/domain';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FilesService } from './files.service.js';
import type { UploadSessionsRepository } from './upload-sessions.repository.js';

/**
 * USAGE-001, slice 1 — the expiry sweeper: `49-PRICING` §6 step 7 for the reservations
 * nobody completed or cancelled.
 *
 * An upload session is a reservation against the organization's storage quota, and a
 * browser that closed mid-upload, or a person who left (FILE-001b decision 7), leaves the
 * bytes counted and the provider upload open. Until this ran, the only thing that returned
 * them was the next `complete` call on that session, which nobody was going to make. One
 * pass here finds every `reserved` session past the cutoff, in every organization, and
 * expires each one through {@link FilesService.expire} — the same release `cancel` and a
 * refused completion use, with `usage.storage_released.v1` (cause `expired`) as its event
 * and one audit row as its trace.
 *
 * ## Why it lives in the API and not the worker
 *
 * The release must ask the object store to abandon the upload, and the worker has no
 * storage driver; and the worker credential has no `UPDATE` on `upload_sessions`,
 * `usage_counters` or `file_assets` (`scripts/db/users.sql`), while `tmanage_app` does. It
 * is driven the way the relay is: `sweep:once`, one pass and exit, from the same external
 * tick — decision 10.
 *
 * ## Why the scan is two steps
 *
 * A `TenantContext` binds one organization, and the index for this read
 * (`ix_upload_sessions_org_status_expires`) is organization-prefixed, so the pass first
 * asks, unscoped, *which* organizations hold expired reservations — through
 * `bootstrapRead`, the audited escape hatch, with a reason string that names this use —
 * and then sweeps each under its own service context, in batches, until a batch releases
 * nothing. Decision 2: this is a new use of the escape hatch, recorded as such.
 *
 * ## The clock
 *
 * `expires_at` was minted from the API host's clock and `complete` refuses against that
 * same clock, so the cutoff is taken from it too and bound as a parameter — never
 * `NOW(3)`. Two clocks would let this expire a session `complete` still accepted.
 *
 * ## The claim, and the second door
 *
 * Since migration 0017 a completion claims its row (`reserved → completing`) before it
 * asks the provider, and this pass selects only `reserved` rows: a completion in flight
 * when the pass runs is not selected, and one that claims between the select and the
 * release makes the conditional transition answer `false` (counted `skipped`). The grace
 * ({@link sweepCutoff}) stays, for the completion that passed its expiry check a moment
 * before expiry and has not yet claimed. What the claim cannot cover is a process that
 * died holding one: that row is `completing` for good — complete and cancel answer 409,
 * and expiry does not see it — with the bytes counted and the provider upload open. So a
 * pass has a second door: every claim older than {@link STALE_CLAIM_MS} is returned to
 * `reserved` ({@link FilesService.reclaim}) and then, if it is also past the cutoff, taken
 * by the expiry in the same pass. The reclaim releases nothing itself; a reclaimed row
 * that is still inside its lifetime waits for its opener or for expiry like any other.
 */

export interface SweepReport {
  /** Organizations that held at least one expired reservation when the pass began. */
  readonly organizations: number;
  /** Rows the per-organization batches selected, over the whole pass. */
  readonly scanned: number;
  /** Rows this pass moved to `expired`. */
  readonly released: number;
  /** Rows that had left `reserved` between selection and release — a complete, a cancel, or another pass. */
  readonly skipped: number;
  /** Rows whose release threw. Logged by the caller; the row stays `reserved` for the next pass. */
  readonly failed: number;
  /** Released rows whose counter refused the release — recorded on their audit rows as `counter_drift`. */
  readonly counterDrift: number;
  /** Claims older than {@link STALE_CLAIM_MS} this pass returned to `reserved` (decision 12). */
  readonly reclaimed: number;
}

/** The `policyVersion` every sweeper context carries — a literal no resolved context can produce. */
export const SWEEP_POLICY_VERSION = 'upload-expiry-sweep';

/** Rows per organization per batch. A batch is one select and one release per row. */
export const SWEEP_BATCH_SIZE = 100;

/** A ceiling on batches per organization per pass, so a row that fails every time cannot loop forever. */
const MAX_BATCHES_PER_ORGANIZATION = 100;

/**
 * How long past `expires_at` a reservation must be before a pass may take it — a minute.
 *
 * `complete` refuses a session at `expires_at` exactly, so a client gains nothing from the
 * grace; what it buys is that a completion which passed that check *just* before expiry
 * and is still streaming the last part to the provider is not undercut by a pass that
 * started a second later. Nothing in the pack names a value; this one is the sweeper's
 * and is Peter's to change (USAGE-001 decision 11) — one edit here.
 */
export const EXPIRY_GRACE_MS = 60_000;

/** The instant before which a `reserved` session counts as abandoned. */
export function sweepCutoff(now: Date): Date {
  return new Date(now.getTime() - EXPIRY_GRACE_MS);
}

/**
 * How old a `completing` claim must be before a pass returns it to `reserved` — fifteen
 * minutes. A live completion moves its row again within the one provider call it makes,
 * and `UPLOAD_URL_TTL_SECONDS` bounds the parts' own lifetime; a claim older than this
 * belongs to a process that died holding it. Too short and a slow assembly is undercut —
 * the one row's race reopened, no more; too long and a dead claim holds the bytes and one
 * of the opener's capped slots. Nothing in the pack names a value; this one is the
 * sweeper's and is Peter's to change (USAGE-001 decision 12) — one edit here.
 */
export const STALE_CLAIM_MS = 15 * 60_000;

/** The instant before which a claim's last move marks it stale. */
export function staleClaimCutoff(now: Date): Date {
  return new Date(now.getTime() - STALE_CLAIM_MS);
}

/**
 * The context one organization is swept under. Decision 1: a service context bound to the
 * organization and to nobody — see `createServiceContext` for the sentinel and why every
 * audit row on this path names `actorUserId: null` explicitly.
 */
export function sweeperContextFor(organizationId: string, correlationId: string): TenantContext {
  return createServiceContext({
    organizationId,
    correlationId,
    policyVersion: SWEEP_POLICY_VERSION,
  });
}

/**
 * What a failed release is logged as: fields, never the error object. A driver error's
 * message is its `sqlMessage`, which quotes the offending value, and its `sql` (stripped at
 * the database boundary) inlined every bound one; an operator acts on the name and the
 * code, and nothing the row held belongs on stderr (security review 2026-09-04).
 */
export function describeFailure(error: unknown): Record<string, string | number> {
  if (!(error instanceof Error)) return { kind: typeof error };
  const candidate = error as Error & {
    code?: unknown;
    errno?: unknown;
    sqlState?: unknown;
    sqlMessage?: unknown;
  };
  const driver = candidate.sqlState !== undefined || candidate.sqlMessage !== undefined;
  return {
    name: error.name,
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof candidate.errno === 'number' ? { errno: candidate.errno } : {}),
    // Reversal: log the message for a driver error too and the quoted value is on stderr.
    ...(driver ? {} : { message: error.message }),
  };
}

/** The reason string the bootstrap read records on every guard event it raises. */
export const SWEEP_SCAN_REASON =
  'finding which organizations hold upload reservations past their expiry or completion ' +
  'claims gone stale, so each can be swept under its own service context (USAGE-001)';

export class UploadSessionSweeper {
  constructor(
    private readonly database: TenantDatabase,
    private readonly sessions: UploadSessionsRepository,
    private readonly files: FilesService,
    /** Injectable for the suite; the process clock otherwise. */
    private readonly now: () => Date = () => new Date(),
    /** Where a failed release is reported. The row is named, never its payload. */
    private readonly onFailure: (uploadSessionId: string, error: unknown) => void = (id, error) =>
      console.error(`[sweeper] releasing upload session ${id} failed`, describeFailure(error)),
  ) {}

  /** One pass over every organization. Safe to run again at once: a second pass finds nothing. */
  async sweep(): Promise<SweepReport> {
    const correlationId = uuidv7();
    const now = this.now();
    const cutoff = sweepCutoff(now);
    const staleBefore = staleClaimCutoff(now);
    const organizations = await this.organizationsHoldingExpired(
      cutoff,
      staleBefore,
      correlationId,
    );

    let scanned = 0;
    let released = 0;
    let skipped = 0;
    let failed = 0;
    let counterDrift = 0;
    let reclaimed = 0;

    for (const organizationId of organizations) {
      const context = sweeperContextFor(organizationId, correlationId);
      // The second door first, so a reclaimed row that is also past the cutoff is taken by
      // the expiry below in this same pass rather than the next.
      reclaimed += await this.reclaimStaleClaims(context, staleBefore);
      for (let batch = 0; batch < MAX_BATCHES_PER_ORGANIZATION; batch += 1) {
        const rows = await this.database.read(context, (db) =>
          this.sessions.listExpired(db, context, cutoff, SWEEP_BATCH_SIZE),
        );
        scanned += rows.length;
        let releasedInBatch = 0;
        for (const row of rows) {
          try {
            const outcome = await this.files.expire(context, row);
            if (outcome.released) {
              released += 1;
              releasedInBatch += 1;
              if (!outcome.counterMoved) counterDrift += 1;
            } else {
              skipped += 1;
            }
          } catch (error) {
            failed += 1;
            this.onFailure(row.id, error);
          }
        }
        // A batch that released nothing has only rows that failed or were taken by
        // someone else; selecting again would find the same rows.
        if (rows.length < SWEEP_BATCH_SIZE || releasedInBatch === 0) break;
      }
    }

    return {
      organizations: organizations.length,
      scanned,
      released,
      skipped,
      failed,
      counterDrift,
      reclaimed,
    };
  }

  /**
   * Return every stale claim in this organization to `reserved`, in batches until a batch
   * moves nothing. A claim that a live completion settles between the select and the move
   * answers `false` and is not counted; a throw is reported like a failed release and the
   * row waits for the next pass.
   */
  private async reclaimStaleClaims(context: TenantContext, staleBefore: Date): Promise<number> {
    let reclaimed = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_ORGANIZATION; batch += 1) {
      const rows = await this.database.read(context, (db) =>
        this.sessions.listStaleClaims(db, context, staleBefore, SWEEP_BATCH_SIZE),
      );
      let movedInBatch = 0;
      for (const row of rows) {
        try {
          if (await this.files.reclaim(context, row)) {
            reclaimed += 1;
            movedInBatch += 1;
          }
        } catch (error) {
          this.onFailure(row.id, error);
        }
      }
      if (rows.length < SWEEP_BATCH_SIZE || movedInBatch === 0) break;
    }
    return reclaimed;
  }

  /**
   * The cross-tenant half: which organizations hold a `reserved` session past the cutoff
   * or a claim older than `staleBefore`. The escape hatch is read-only, allowlisted to
   * `upload_sessions`, and raises a guard event per statement carrying
   * {@link SWEEP_SCAN_REASON}; the statement itself is the repository's.
   */
  private organizationsHoldingExpired(
    cutoff: Date,
    staleBefore: Date,
    correlationId: string,
  ): Promise<readonly string[]> {
    return this.database.bootstrapRead(
      { correlationId, reason: SWEEP_SCAN_REASON, tables: ['upload_sessions'] },
      (db) => this.sessions.organizationsHoldingExpired(db, cutoff, staleBefore),
    );
  }
}

/** The one line a pass prints — `e2e/setup/stack.ts`'s `sweepUploads` parses it. */
export function describeSweep(report: SweepReport): string {
  return (
    `scanned ${report.scanned}, released ${report.released}, skipped ${report.skipped}, ` +
    `failed ${report.failed}` +
    (report.counterDrift > 0 ? `, ${report.counterDrift} with counter drift` : '') +
    (report.reclaimed > 0 ? `, ${report.reclaimed} claim(s) reclaimed` : '') +
    ` (${report.organizations} organization(s))`
  );
}
