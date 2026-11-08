import { authorize } from '@tmanage/domain';
import type { Principal, WorkItemState } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { SeedCipher } from '../identity/seed-cipher.js';
import { connectorBinding } from '../connectors/connectors.service.js';
import type { ConnectorsRepository } from '../connectors/connectors.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import type { WorkCommentsRepository } from '../work/work-comments.repository.js';
import type { ImportJobsRepository } from './import-jobs.repository.js';
import type { ImportRowsRepository } from './import-rows.repository.js';
import { PmFetchError } from './pm-egress.js';
import type { PmFetch } from './pm-egress.js';
import {
  isPmBoardId,
  listPmBoards,
  parsePmCredential,
  readPmBoards,
  verifyPmCredential,
} from './pm-sources.js';
import type { PmBoard, PmBoardData, PmCredential, PmSource } from './pm-sources.js';
import {
  buildPmPlan,
  extractMarkers,
  parsePmImportOptions,
  suggestPmMapping,
} from './pm-import-plan.js';
import type {
  PmImportOptions,
  PmMappingSuggestion,
  PmPlan,
  PmTargetState,
} from './pm-import-plan.js';
import type { PmImportRepository } from './pm-import.repository.js';

/**
 * R45 L3 (54-25) — Trello and Asana import with the owner's own personal token.
 *
 * ## The token
 *
 * `connect` checks the pasted credential with one cheap call, then stores it **only** in the token
 * vault (`connector_installations`, `SeedCipher`, bound to the organization and the key
 * `import_trello` / `import_asana`). It never comes back out through a view. The import job reads
 * it once and deletes it in a `finally` — success, failure or crash of the read alike. `disconnect`
 * deletes it when the owner walks away, and a credential older than {@link PM_VAULT_TTL_MS} is
 * treated as gone (and deleted) on its next read.
 *
 * ## The flow
 *
 * `connect` → boards / projects; `discover` → lists / sections, people and a suggested mapping;
 * `preview` → counts including the cards already imported; `start` → a job row (`import_jobs`,
 * kind `trello_cards` / `asana_tasks`) and a background run that writes work items with their due
 * dates, statuses, owners and comments, one transaction per card, one `import_rows` receipt per
 * card, then stamps the job. A committed job uses the shared receipt and undo routes.
 *
 * Every method is `org.manage` (import sits under Admin, 41 §ADM-10), re-checked here, and the
 * target project must allow `work.create` for the caller.
 */

export const PM_IMPORT_SERVICE = Symbol.for('tmanage.PmImportService');

/** How long a pasted token may wait in the vault for its import. */
export const PM_VAULT_TTL_MS = 60 * 60 * 1000;

export const PM_JOB_KIND: Readonly<Record<PmSource, string>> = {
  trello: 'trello_cards',
  asana: 'asana_tasks',
};

export function pmVaultKey(source: PmSource): string {
  return `import_${source}`;
}

/** The forward path from `backlog` to each importable state (as `jira-commit.ts`). */
const PATH_TO: Readonly<Record<PmTargetState, readonly WorkItemState[]>> = {
  backlog: [],
  ready: ['ready'],
  in_progress: ['ready', 'in_progress'],
  internal_review: ['ready', 'in_progress', 'internal_review'],
  done: ['ready', 'in_progress', 'internal_review', 'done'],
};

export interface PmImportDeps {
  readonly fetch: PmFetch;
  readonly cipher: Pick<SeedCipher, 'encrypt' | 'decrypt'>;
  readonly vault: Pick<ConnectorsRepository, 'findByKey' | 'insert' | 'remove'>;
  readonly pm: Pick<
    PmImportRepository,
    'importedDescriptions' | 'activeUserIdsByEmail' | 'activeUserIds'
  >;
  readonly projects: Pick<ProjectsRepository, 'findById'>;
  readonly jobs: Pick<ImportJobsRepository, 'create' | 'findById' | 'markCommitted'>;
  readonly rows: Pick<ImportRowsRepository, 'create'>;
  readonly workItems: Pick<WorkItemsRepository, 'create' | 'transitionState'>;
  readonly comments: Pick<WorkCommentsRepository, 'create'>;
  readonly now: () => Date;
  /** Runs the job after the response; tests pass a collector. */
  readonly schedule: (task: () => Promise<void>) => void;
}

export interface PmPersonView {
  readonly key: string;
  readonly name: string;
  readonly email: string | null;
}

export interface PmDiscoverView {
  readonly containers: readonly string[];
  readonly people: readonly PmPersonView[];
  readonly suggestion: PmMappingSuggestion;
  readonly cardCount: number;
  readonly truncated: boolean;
}

export interface PmPreviewView {
  readonly counts: PmPlan['counts'];
  readonly unmappedContainers: readonly string[];
  readonly unmatchedPeople: readonly string[];
  readonly truncated: boolean;
}

export type PmJobStatus = 'running' | 'committed' | 'committed_with_errors' | 'failed';

export interface PmJobView {
  readonly jobId: string;
  readonly source: PmSource;
  readonly status: PmJobStatus;
  readonly committedCount: number;
  readonly failedCount: number;
}

function invalid(details: { field: string; message: string }[]): ApiError {
  return new ApiError(422, 'validation_failed', 'Check the highlighted fields', details);
}

function notConnected(): ApiError {
  return new ApiError(409, 'conflict', 'Paste your token again to continue', [
    { field: 'token', message: 'not_connected' },
  ]);
}

/** A provider failure as an API error: fixed text, never the credential or the provider's body. */
export function pmFetchProblem(error: unknown): ApiError {
  if (!(error instanceof PmFetchError)) throw error;
  if (error.code === 'pm_rate_limited') {
    return new ApiError(
      429,
      'rate_limited',
      'The service is busy. Try again in a minute',
      [
        { field: 'source', message: error.code },
        { field: 'retryAfterSeconds', message: String(error.retryAfterSeconds ?? 60) },
      ],
      error.code,
    );
  }
  if (error.code === 'pm_not_found') {
    return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, error.code);
  }
  const field = error.code === 'pm_auth_failed' ? 'token' : 'source';
  return new ApiError(
    422,
    'validation_failed',
    error.message,
    [{ field, message: error.code }],
    error.code,
  );
}

export class PmImportService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly deps: PmImportDeps,
  ) {}

  private requireManage(context: TenantContext, principal: Principal): void {
    const { allowed } = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'denied_org.manage');
    }
  }

  // ─── The vault ─────────────────────────────────────────────────────────

  private async storeCredential(context: TenantContext, credential: PmCredential): Promise<void> {
    const key = pmVaultKey(credential.source);
    const credentialEnc = this.deps.cipher.encrypt(
      JSON.stringify({ apiKey: credential.apiKey ?? null, token: credential.token }),
      connectorBinding(context.organizationId, key),
    );
    await this.database.transaction(context, async (tx) => {
      // One pending token per source: a second connect replaces the first.
      await this.deps.vault.remove(tx, context, key);
      await this.deps.vault.insert(tx, context, {
        connectorKey: key,
        credentialEnc,
        credentialHint: credential.token.slice(-4),
      });
    });
  }

  private async readCredential(
    context: TenantContext,
    source: PmSource,
  ): Promise<PmCredential | null> {
    const key = pmVaultKey(source);
    const row = await this.database.read(context, (runner) =>
      this.deps.vault.findByKey(runner, context, key),
    );
    if (!row?.credentialEnc) return null;
    if (this.deps.now().getTime() - row.installedAt.getTime() > PM_VAULT_TTL_MS) {
      await this.deleteCredential(context, source);
      return null;
    }
    try {
      const plain = JSON.parse(
        this.deps.cipher.decrypt(row.credentialEnc, connectorBinding(context.organizationId, key)),
      ) as { apiKey?: unknown; token?: unknown };
      return parsePmCredential(source, plain);
    } catch {
      return null;
    }
  }

  private async deleteCredential(context: TenantContext, source: PmSource): Promise<void> {
    await this.database.transaction(context, (tx) =>
      this.deps.vault.remove(tx, context, pmVaultKey(source)),
    );
  }

  private async requireCredential(context: TenantContext, source: PmSource): Promise<PmCredential> {
    const credential = await this.readCredential(context, source);
    if (credential === null) throw notConnected();
    return credential;
  }

  // ─── Routes ────────────────────────────────────────────────────────────

  async connect(
    context: TenantContext,
    principal: Principal,
    source: PmSource,
    body: { readonly apiKey?: unknown; readonly token?: unknown } | undefined,
  ): Promise<{ readonly boards: readonly PmBoard[] }> {
    this.requireManage(context, principal);
    const credential = parsePmCredential(source, body ?? {});
    if (credential === null) {
      throw invalid([
        { field: source === 'trello' ? 'apiKey' : 'token', message: 'Paste a valid token' },
      ]);
    }
    let boards: PmBoard[];
    try {
      await verifyPmCredential(this.deps.fetch, credential);
      boards = await listPmBoards(this.deps.fetch, credential);
    } catch (error) {
      throw pmFetchProblem(error);
    }
    await this.storeCredential(context, credential);
    return { boards };
  }

  async disconnect(context: TenantContext, principal: Principal, source: PmSource): Promise<void> {
    this.requireManage(context, principal);
    await this.deleteCredential(context, source);
  }

  private parseBoards(source: PmSource, body: Readonly<Record<string, unknown>> | undefined) {
    const raw = body?.['boardIds'];
    const ids = Array.isArray(raw) ? [...new Set(raw)] : [];
    if (ids.length === 0 || ids.length > 10 || !ids.every((id) => isPmBoardId(source, id))) {
      throw invalid([{ field: 'boardIds', message: 'choose between 1 and 10 boards' }]);
    }
    return ids as string[];
  }

  private async read(
    credential: PmCredential,
    boardIds: readonly string[],
    withComments: boolean,
  ): Promise<PmBoardData> {
    try {
      return await readPmBoards(this.deps.fetch, credential, boardIds, withComments);
    } catch (error) {
      throw pmFetchProblem(error);
    }
  }

  async discover(
    context: TenantContext,
    principal: Principal,
    source: PmSource,
    body: Readonly<Record<string, unknown>> | undefined,
  ): Promise<PmDiscoverView> {
    this.requireManage(context, principal);
    const boardIds = this.parseBoards(source, body);
    const credential = await this.requireCredential(context, source);
    const data = await this.read(credential, boardIds, false);
    const emails = data.people.flatMap((p) => (p.email === null ? [] : [p.email]));
    const byEmail = await this.database.read(context, (runner) =>
      this.deps.pm.activeUserIdsByEmail(runner, context, emails),
    );
    return {
      containers: data.containers,
      people: data.people.map((p) => ({ key: p.key, name: p.name, email: p.email })),
      suggestion: suggestPmMapping(data, byEmail),
      cardCount: data.cards.filter((c) => !c.archived).length,
      truncated: data.truncated,
    };
  }

  private async requireProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    const project = await this.database.read(context, (runner) =>
      this.deps.projects.findById(runner, context, projectId),
    );
    if (!project) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'import_project_not_visible',
      );
    }
    const verdict = authorize({
      principal,
      capability: 'work.create',
      resource: {
        organizationId: context.organizationId,
        projectId: project.id,
        audience: 'internal',
        lifecycle: project.archivedAt === null ? 'active' : 'archived',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.detail);
    }
  }

  private options(source: PmSource, body: Readonly<Record<string, unknown>> | undefined) {
    const details: { field: string; message: string }[] = [];
    const options = parsePmImportOptions(source, body, details);
    if (options === null) throw invalid(details);
    return options;
  }

  private async plan(
    context: TenantContext,
    source: PmSource,
    data: PmBoardData,
    options: PmImportOptions,
  ): Promise<PmPlan> {
    const mapped = Object.values(options.userMap).filter((v): v is string => v !== null);
    const { descriptions, active } = await this.database.read(context, async (runner) => ({
      descriptions: await this.deps.pm.importedDescriptions(runner, context, options.projectId),
      active: await this.deps.pm.activeUserIds(runner, context, mapped),
    }));
    return buildPmPlan(source, data, options, {
      markers: extractMarkers(descriptions),
      activeUserIds: active,
    });
  }

  async preview(
    context: TenantContext,
    principal: Principal,
    source: PmSource,
    body: Readonly<Record<string, unknown>> | undefined,
  ): Promise<PmPreviewView> {
    this.requireManage(context, principal);
    const options = this.options(source, body);
    await this.requireProject(context, principal, options.projectId);
    const credential = await this.requireCredential(context, source);
    // Trello comments come in one call per board; Asana needs one per task, so its preview
    // counts them during the import instead (`counts.comments` is null).
    const data = await this.read(credential, options.boardIds, source === 'trello');
    const plan = await this.plan(context, source, data, options);
    return {
      counts: plan.counts,
      unmappedContainers: plan.unmappedContainers,
      unmatchedPeople: plan.unmatchedPeople,
      truncated: plan.truncated,
    };
  }

  async start(
    context: TenantContext,
    principal: Principal,
    source: PmSource,
    body: Readonly<Record<string, unknown>> | undefined,
  ): Promise<PmJobView> {
    this.requireManage(context, principal);
    const options = this.options(source, body);
    await this.requireProject(context, principal, options.projectId);
    if ((await this.readCredential(context, source)) === null) throw notConnected();
    const job = await this.database.transaction(context, (tx) =>
      this.deps.jobs.create(tx, context, {
        createdByUserId: context.userId,
        sourceKind: PM_JOB_KIND[source],
        status: 'validated',
        totalCount: 0,
        validCount: 0,
        invalidCount: 0,
      }),
    );
    this.deps.schedule(() => this.run(context, source, job.id, options));
    return { jobId: job.id, source, status: 'running', committedCount: 0, failedCount: 0 };
  }

  async job(
    context: TenantContext,
    principal: Principal,
    source: PmSource,
    jobId: string,
  ): Promise<PmJobView> {
    this.requireManage(context, principal);
    const job = await this.database.read(context, (runner) =>
      this.deps.jobs.findById(runner, context, jobId),
    );
    if (!job || job.sourceKind !== PM_JOB_KIND[source]) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'import_job_not_visible');
    }
    const status: PmJobStatus =
      job.status === 'committed' ||
      job.status === 'committed_with_errors' ||
      job.status === 'failed'
        ? job.status
        : 'running';
    return {
      jobId: job.id,
      source,
      status,
      committedCount: job.committedCount ?? 0,
      failedCount: job.failedCount ?? 0,
    };
  }

  // ─── The job ───────────────────────────────────────────────────────────

  /**
   * The background run. Reads the token once, deletes it whatever happens, then writes one card
   * per transaction. Never throws: a failure is stamped on the job.
   */
  async run(
    context: TenantContext,
    source: PmSource,
    jobId: string,
    options: PmImportOptions,
  ): Promise<void> {
    let data: PmBoardData | null = null;
    try {
      const credential = await this.readCredential(context, source);
      if (credential !== null) {
        data = await readPmBoards(this.deps.fetch, credential, options.boardIds, true);
      }
    } catch {
      data = null;
    } finally {
      await this.deleteCredential(context, source).catch(() => undefined);
    }
    if (data === null) {
      await this.stamp(context, jobId, 'failed', 0, 0);
      return;
    }
    let committed = 0;
    let failed = 0;
    try {
      const plan = await this.plan(context, source, data, options);
      const at = this.deps.now();
      for (let index = 0; index < plan.items.length; index += 1) {
        const item = plan.items[index]!;
        try {
          await this.database.transaction(context, async (tx) => {
            const created = await this.deps.workItems.create(tx, context, {
              projectId: options.projectId,
              title: item.title,
              description: item.description,
              type: 'task',
              ownerUserId: item.ownerUserId,
              dueAt: item.dueAt,
            });
            let version = created.version;
            for (const to of PATH_TO[item.state]) {
              const done = to === 'done';
              const completedBy = item.ownerUserId ?? context.userId;
              const row = await this.deps.workItems.transitionState(
                tx,
                context,
                created.id,
                version,
                to,
                done ? { ownerId: completedBy, completedAt: at.toISOString() } : {},
                done ? { ownerUserId: completedBy, completedAt: at } : undefined,
              );
              version = row.version;
            }
            for (const comment of item.comments) {
              await this.deps.comments.create(tx, context, {
                workItemId: created.id,
                authorMembershipId: context.membershipId,
                body: comment,
              });
            }
            await this.deps.rows.create(tx, context, {
              jobId,
              sourceIndex: index,
              outcome: 'created',
              createdEntityId: created.id,
              entityType: 'work_item',
            });
          });
          committed += 1;
        } catch {
          failed += 1;
          await this.database
            .transaction(context, (tx) =>
              this.deps.rows.create(tx, context, {
                jobId,
                sourceIndex: index,
                outcome: 'failed',
                errorDetail: 'This card could not be imported',
              }),
            )
            .catch(() => undefined);
        }
      }
    } catch {
      await this.stamp(context, jobId, 'failed', committed, failed);
      return;
    }
    await this.stamp(
      context,
      jobId,
      failed > 0 ? 'committed_with_errors' : 'committed',
      committed,
      failed,
    );
  }

  private async stamp(
    context: TenantContext,
    jobId: string,
    status: 'committed' | 'committed_with_errors' | 'failed',
    committedCount: number,
    failedCount: number,
  ): Promise<void> {
    await this.database
      .transaction(context, (tx) =>
        this.deps.jobs.markCommitted(tx, context, jobId, { status, committedCount, failedCount }),
      )
      .catch(() => undefined);
  }
}
