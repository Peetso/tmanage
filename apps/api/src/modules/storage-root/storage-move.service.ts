import { isUuid, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { StorageMigrationJobRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { isDuplicateKey } from '../tenancy/invitee-accounts.repository.js';
import { StorageHandoverRepository } from './storage-handover.repository.js';
import { live, parseProvider, requireStorageAdmin } from './storage-handover.service.js';
import { StorageMoveRepository } from './storage-move.repository.js';

/**
 * 57-13b. "Move to Drive": start and read the job that moves the files TManage still holds into
 * the company's connected Google Drive or OneDrive (plan 57 §19.3).
 *
 * Only `org.security.manage` (Owner, Org Admin), decided again here for the acting tenant. The
 * request names only the provider: the destination is the connection's own TManage folder, read
 * by the provider service from our own row, and the files are the company's own local, clean
 * versions, chosen by the job under the same tenant. A company has at most one live job; asking
 * again while one runs answers that job. The work itself is `storage-move-job.ts`.
 */

export interface StorageMoveView {
  readonly id: string;
  readonly provider: 'google_drive' | 'onedrive';
  readonly status: StorageMigrationJobRow['status'];
  readonly total: number;
  readonly moved: number;
  readonly failed: number;
  readonly skipped: number;
  readonly movedBytes: number;
  /** Why a job stopped (`not_connected`, `provider_unavailable`, `connection_changed`), else null. */
  readonly error: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** The latest job of the company, for the storage card after a reload. */
export type StorageMoveLatest = { readonly job: StorageMoveView | null };

/** The job timer's nudge after a start, so the first pass does not wait for the interval. */
export interface StorageMoveRequester {
  request(): void;
}

const ACTIVE_KEY = 'uq_storage_migration_jobs_active';

export class StorageMoveService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly audit: Pick<AuditService, 'record'>,
    private readonly job: StorageMoveRequester | undefined,
    private readonly jobs: StorageMoveRepository = new StorageMoveRepository(),
    private readonly connections: Pick<
      StorageHandoverRepository,
      'findConnection'
    > = new StorageHandoverRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<StorageMoveView> {
    requireStorageAdmin(context, principal);
    const provider = parseProvider((body as { readonly provider?: unknown } | null)?.provider);
    let row: StorageMigrationJobRow | undefined;
    try {
      row = await this.database.transaction(context, async (tx) => {
        const connection = live(await this.connections.findConnection(tx, context, provider));
        if (!connection || connection.rootFolderId === null) {
          throw new ApiError(409, 'conflict', 'This storage is not connected', [
            { field: 'storage', message: 'not_connected' },
          ]);
        }
        const running = await this.jobs.findActive(tx, context);
        if (running) return running;
        const id = uuidv7();
        const total = await this.jobs.countCandidates(tx, context);
        await this.jobs.insert(tx, context, {
          id,
          backend: provider,
          storageConnectionId: connection.id,
          requestedByUserId: principal.userId,
          total,
          now: this.now(),
        });
        await this.audit.record(tx, context, {
          action: 'storage_migration.started',
          result: 'allowed',
          objectId: id,
          metadata: { provider, files: total },
        });
        return this.jobs.findById(tx, context, id);
      });
    } catch (error) {
      // Two starts at once: the other one's insert won the one live slot; answer its job.
      if (!isDuplicateKey(error, ACTIVE_KEY)) throw error;
      row = await this.database.read(context, (runner) => this.jobs.findActive(runner, context));
    }
    if (!row) throw new ApiError(409, 'conflict', MESSAGES.conflict);
    this.job?.request();
    return view(row);
  }

  async status(
    context: TenantContext,
    principal: Principal,
    jobId: string,
  ): Promise<StorageMoveView> {
    requireStorageAdmin(context, principal);
    if (!isUuid(jobId)) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const row = await this.database.read(context, (runner) =>
      this.jobs.findById(runner, context, jobId),
    );
    // Another company's job does not resolve under this tenant: the same answer as an unknown id.
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return view(row);
  }

  async latest(context: TenantContext, principal: Principal): Promise<StorageMoveLatest> {
    requireStorageAdmin(context, principal);
    const row = await this.database.read(context, (runner) =>
      this.jobs.findLatest(runner, context),
    );
    return { job: row ? view(row) : null };
  }
}

function view(row: StorageMigrationJobRow): StorageMoveView {
  return {
    id: row.id,
    provider: row.backend,
    status: row.status,
    total: row.total,
    moved: row.moved,
    failed: row.failed,
    skipped: row.skipped,
    movedBytes: row.movedBytes,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
