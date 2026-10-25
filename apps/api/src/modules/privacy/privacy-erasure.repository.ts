import type { ObjectStore } from '@tmanage/storage';
import { TENANT_TABLES } from '../../common/database/tenant-guard.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * H3 (audit gap 3, NFR-09, 33-LEGAL §8) — the erasure that follows a company deletion.
 *
 * The privacy job closes a company once its grace period ends (`privacy-job.ts`). A day later this
 * erases what the company held: first every stored file's bytes, then every row of every tenant
 * table, in batches. Rules it keeps:
 *
 * - **One tenant only.** Every statement is `… where organization_id = ?` under the company's own
 *   service context, so the tenant guard checks it like any other; an object key is removed only
 *   when it sits under the company's own `tenant/<id>/` prefix.
 * - **Batched and resumable.** Rows go `limit` {@link ErasureOptions.batchRows} at a time, each batch
 *   its own short transaction, and one run stops after {@link ErasureOptions.maxRowsPerRun} rows; the
 *   next pass carries on where it stopped. Running it again over an erased company finds nothing.
 * - **Foreign keys respected, never switched off.** Tables are tried children-first (the reverse of
 *   their registration order); a table still referenced by rows not deleted yet is retried in the
 *   next round. A table that stays refused after a round with no progress is reported as blocked,
 *   and the erasure is left incomplete rather than forced.
 * - **What is kept** ({@link RETAINED_TABLES}): the audit trail (append-only, retained by 33-LEGAL
 *   §7), its retention setting, the two privacy tables (the record of who asked for what and when),
 *   and the organization row itself, which those keep pointing at.
 */

export const RETAINED_TABLES: ReadonlySet<string> = new Set([
  'organizations',
  'audit_events',
  'audit_retention_policy',
  'privacy_exports',
  'privacy_deletion_requests',
]);

/** Every tenant table the erasure empties, children-first (the reverse of registration order). */
export function erasableTables(
  registry: Readonly<Record<string, 'organization_id' | 'id'>> = TENANT_TABLES,
): readonly string[] {
  return Object.entries(registry)
    .filter(([table, column]) => column === 'organization_id' && !RETAINED_TABLES.has(table))
    .map(([table]) => table)
    .reverse();
}

export interface ErasureOptions {
  readonly batchRows: number;
  readonly maxRowsPerRun: number;
}

export const DEFAULT_ERASURE_OPTIONS: ErasureOptions = { batchRows: 500, maxRowsPerRun: 20_000 };

export interface ErasureOutcome {
  /** True when every erasable table is empty for the company and its files are gone. */
  readonly complete: boolean;
  readonly rowsErased: number;
  readonly objectsRemoved: number;
  /** Tables left with rows after a round without progress, and why (`referenced`, `refused`, …). */
  readonly blocked: Readonly<Record<string, string>>;
}

/** MariaDB errnos a refused DELETE can carry, and what they mean for the erasure. */
const ER_NO_SUCH_TABLE = 1146;
const BLOCKING_ERRNOS: Readonly<Record<number, string>> = {
  1451: 'referenced', // ER_ROW_IS_REFERENCED_2: a row elsewhere still points at it
  1217: 'referenced', // ER_ROW_IS_REFERENCED
  1644: 'refused', // ER_SIGNAL_EXCEPTION: a trigger refused the delete
  1142: 'not_permitted', // ER_TABLEACCESS_DENIED_ERROR: the credential holds no DELETE here
};

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function quoted(table: string): string {
  if (!IDENTIFIER.test(table)) throw new Error(`not a plain identifier: ${table}`);
  return `\`${table}\``;
}

function errnoOf(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const errno = (current as { errno?: unknown }).errno;
    if (typeof errno === 'number') return errno;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function affected(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as unknown) : result;
  const rows = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}

type Drain =
  | { readonly state: 'empty'; readonly deleted: number }
  | { readonly state: 'budget'; readonly deleted: number }
  | { readonly state: 'blocked'; readonly deleted: number; readonly reason: string };

/** The stored objects a company's rows name, and the zones they may sit in. */
const OBJECT_SOURCES: readonly {
  readonly table: string;
  readonly zones: readonly ('quarantine' | 'private')[];
}[] = [
  { table: 'file_versions', zones: ['quarantine', 'private'] },
  { table: 'upload_sessions', zones: ['quarantine'] },
];

const KEY_PAGE = 500;

export class CompanyErasure {
  constructor(
    private readonly database: TenantDatabase,
    private readonly store: Pick<ObjectStore, 'remove'>,
    private readonly tables: readonly string[] = erasableTables(),
    private readonly options: ErasureOptions = DEFAULT_ERASURE_OPTIONS,
  ) {}

  async run(context: TenantContext): Promise<ErasureOutcome> {
    const objectsRemoved = await this.removeStoredFiles(context);
    let budget = this.options.maxRowsPerRun;
    let rowsErased = 0;
    let pending = [...this.tables];
    let blocked: Record<string, string> = {};

    while (pending.length > 0) {
      const next: string[] = [];
      const refused: Record<string, string> = {};
      let progress = false;
      for (const table of pending) {
        if (budget <= 0) {
          return { complete: false, rowsErased, objectsRemoved, blocked: {} };
        }
        const drain = await this.drain(context, table, budget);
        rowsErased += drain.deleted;
        budget -= drain.deleted;
        if (drain.deleted > 0) progress = true;
        if (drain.state === 'empty') {
          progress = true;
          continue;
        }
        next.push(table);
        if (drain.state === 'blocked') refused[table] = drain.reason;
      }
      pending = next;
      blocked = refused;
      if (!progress) break;
    }

    return { complete: pending.length === 0, rowsErased, objectsRemoved, blocked };
  }

  /** Delete the company's rows of one table, a batch per transaction, until none or the budget. */
  private async drain(context: TenantContext, table: string, budget: number): Promise<Drain> {
    let deleted = 0;
    for (;;) {
      const limit = Math.min(this.options.batchRows, budget - deleted);
      if (limit <= 0) return { state: 'budget', deleted };
      let count: number;
      try {
        count = await this.database.transaction(context, async (tx) =>
          affected(
            await tx.execute(
              `delete from ${quoted(table)} where organization_id = ? limit ${String(limit)}`,
              [context.organizationId],
            ),
          ),
        );
      } catch (error) {
        const errno = errnoOf(error);
        if (errno === ER_NO_SUCH_TABLE) return { state: 'empty', deleted };
        const reason = errno === undefined ? undefined : BLOCKING_ERRNOS[errno];
        if (reason !== undefined) return { state: 'blocked', deleted, reason };
        throw error;
      }
      deleted += count;
      if (count < limit) return { state: 'empty', deleted };
    }
  }

  /**
   * Remove the bytes every file row of the company names, from each zone they may be in. `remove`
   * is idempotent, so a run that stopped halfway simply repeats it. A key outside the company's
   * own prefix is never touched.
   */
  private async removeStoredFiles(context: TenantContext): Promise<number> {
    const prefix = `tenant/${context.organizationId}/`;
    let removed = 0;
    for (const source of OBJECT_SOURCES) {
      let after = '';
      for (;;) {
        let page: readonly { id: string; object_key: string }[];
        try {
          page = (await this.database.read(context, (runner) =>
            runner.query(
              `select id, object_key from ${quoted(source.table)}
                where organization_id = ? and id > ? order by id limit ${String(KEY_PAGE)}`,
              [context.organizationId, after],
            ),
          )) as unknown as readonly { id: string; object_key: string }[];
        } catch (error) {
          if (errnoOf(error) === ER_NO_SUCH_TABLE) break;
          throw error;
        }
        for (const row of page) {
          if (typeof row.object_key !== 'string' || !row.object_key.startsWith(prefix)) continue;
          for (const zone of source.zones) {
            await this.store.remove({ zone, objectKey: row.object_key });
          }
          removed += 1;
        }
        const last = page[page.length - 1];
        if (last === undefined || page.length < KEY_PAGE) break;
        after = last.id;
      }
    }
    return removed;
  }
}
