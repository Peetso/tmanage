import { authorize } from '@tmanage/domain';
import type { Audience, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  ProjectsRepository,
  effectivePageSize as projectPageSize,
} from '../projects/projects.repository.js';
import {
  WorkItemsRepository,
  effectivePageSize as workItemPageSize,
} from '../work/work-items.repository.js';
import { ClientProjectionsRepository } from '../approvals/client-projections.repository.js';
import { FileAssetsRepository } from '../files/file-assets.repository.js';
import type {
  ClientProjectionRow,
  FileAssetRow,
  FileVersionRow,
  ProjectRow,
  WorkItemRow,
} from '../../common/database/schema.js';

/**
 * How many repository pages one portal list may walk while filling a page of readable rows.
 *
 * Mirrors `WorkItemsService`: the relation check is `authorize()`'s rule, not a column, so it
 * runs per row *after* the query and can shorten a page. At the largest page size this budget
 * examines 5,000 rows per request — past any tenant this deployment profile serves, and a hard
 * stop on a client who can read almost nothing in a tenant with very many projects. Past the
 * budget the page is returned short; every id walked past still sorts before an unfetched row,
 * so the keyset cursor a caller would page on stays valid.
 */
const LIST_PAGE_BUDGET = 25;

/**
 * The client portal's read surface — CLIENT-002.
 *
 * `CLIENT-001` made a client organization reachable and `TEN-003` made a client member
 * arrivable, and between them a client could sign in and see **nothing**: every endpoint in the
 * system serves the internal record, and `12-PERMISSION-MATRIX` §2 gives every client role
 * "View internal project: **Never**". The assertion parked in `http-pipeline.db.test.ts` since
 * the HTTP surface landed has been waiting for exactly this file.
 *
 * ## Not a filtered internal list
 *
 * `25-AUTH-AND-TENANT-ISOLATION` §7: "Never implement client access as
 * `serializeInternalObject(); delete fields`." Every view here is built field by field from
 * §4's allowlist — "public/client title, summary, milestone state, committed/forecast date,
 * published risk, deliverable version, decision, and approved contacts" — and a column added
 * to `projects` or `work_items` tomorrow is invisible to a client until somebody decides it
 * should not be. That is the safe direction, and it is the whole reason these are separate
 * projections rather than the internal ones with a filter in front.
 *
 * Two omissions are worth naming because they are the ones a filter would have got wrong:
 *
 * - **`ownerUserId` is absent.** §4 excludes staff. Who inside the agency is carrying a piece
 *   of work is an internal fact, and "approved contacts" — a curated list — is what a client
 *   is meant to see instead. That is `CL-10`, unbuilt.
 * - **The internal `state` is absent.** §4 gives "milestone state", not the work lifecycle. A
 *   client reading `internal_review` learns that their deliverable is being argued about
 *   inside the agency, which is precisely the internal signal `26-THREAT-MODELS` treats as a
 *   disclosure. The projection says whether the item is **finished, in progress or waiting on
 *   the client**, which is what the portal is for.
 *
 * ## Three independent gates, and none of them is this file being careful
 *
 * 1. `client_projection.read` — the capability `12-PERMISSION-MATRIX` §1 names and this
 *    codebase did not have until now. `CapabilityGuard` refuses a role without it.
 * 2. `authorize()` per row, which for a client principal refuses any project outside
 *    `principal.projectIds` — and that list comes from `project_clients` and nothing else.
 * 3. The audience filter, which is in the **query**: a client's read of `work_items` never
 *    selects an `internal` row, so there is no result set to be careless with.
 */

export interface PortalProjectView {
  readonly id: string;
  readonly name: string;
  /** §4: "milestone state". Until milestones exist, the project's own status. */
  readonly status: string;
  /** §4 names both dates explicitly, and they mean different things. */
  readonly committedAt: string | null;
  readonly forecastAt: string | null;
}

export interface PortalWorkItemView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /**
   * What the client needs to know, not the internal lifecycle.
   *
   * `waiting_on_you` is the one that earns its place: `client_action_required` is an audience,
   * and a portal that showed it as an ordinary item would bury the only rows the client is
   * expected to act on.
   */
  readonly progress: 'waiting_on_you' | 'in_progress' | 'done';
  readonly dueAt: string | null;
  readonly updatedAt: string;
}

/**
 * One published deliverable version, as the client is allowed to see it — x114.
 *
 * Built **field by field** from the x97 client projection allowlist ({@link ClientProjectionPayload},
 * `12-PERMISSION-MATRIX` §1) and nothing else. A column added to `client_projections` or a key
 * added to the payload is invisible here until somebody adds it below on purpose — the safe
 * direction `25-AUTH` §7 requires, and the reason this is not `{ ...row.projection }`.
 *
 * The three identity fields carry no content: `id` is the frozen version's own id (a stable React
 * key and the immutable identity x97 froze), `deliverableId` is the id the files sub-route names,
 * and `publishedAt` is when the client was given this view. None is an internal record field —
 * there is no owner, no internal state, no content hash, no draft.
 */
export interface PortalDeliverableView {
  /** The published version's id — its immutable identity (x97), and the list's stable key. */
  readonly id: string;
  /** The deliverable this version belongs to — the id `GET …/deliverables/:id/files` names. */
  readonly deliverableId: string;
  /** When this view was published to the client. */
  readonly publishedAt: string;
  /** 12 §1 "public/client title". */
  readonly title: string;
  readonly summary: string | null;
  /** 12 §1 "milestone state". */
  readonly milestoneState: string | null;
  /** 12 §1 "committed/forecast date" — an ISO calendar date, or null. */
  readonly forecastDate: string | null;
  /** 12 §1 "published risk" — never the internal rationale. */
  readonly publishedRisk: string | null;
  /** 12 §1 "decision". */
  readonly decision: string | null;
  /** 12 §1 "approved contacts". */
  readonly approvedContacts: readonly string[];
}

/**
 * One client-visible file attached to a deliverable — x114.
 *
 * The metadata a file list needs and no internal handle: never `objectKey` (a
 * `FORBIDDEN_CLIENT_FIELDS` name), never the owner, audience, status, trust zone or scan
 * verdict. The bytes are a later ticket (the download proxy, NEXT-SCOPES-9); this is the list
 * that says which files exist and how big they are.
 */
export interface PortalDeliverableFileView {
  /** The file asset's id — the future download route's parameter, and the list's key. */
  readonly id: string;
  readonly name: string;
  /** The provider's counted size of the latest version, in bytes. */
  readonly sizeBytes: number;
  /** The detected content type of the latest version, or null when none was detected. */
  readonly mimeType: string | null;
  readonly updatedAt: string;
}

/** The audiences a client may ever see. `internal` is not among them and never will be. */
const CLIENT_AUDIENCES: readonly Audience[] = ['client_visible', 'client_action_required'];

function toDeliverableView(row: ClientProjectionRow): PortalDeliverableView {
  const projection = row.projection;
  return {
    id: row.deliverableVersionId,
    deliverableId: row.deliverableId,
    publishedAt: row.publishedAt.toISOString(),
    // Field by field from the §1 allowlist — never a spread of the payload.
    title: projection.title,
    summary: projection.summary,
    milestoneState: projection.milestoneState,
    forecastDate: projection.forecastDate,
    publishedRisk: projection.publishedRisk,
    decision: projection.decision,
    approvedContacts: projection.approvedContacts,
  };
}

function toDeliverableFileView(
  asset: FileAssetRow,
  version: FileVersionRow,
): PortalDeliverableFileView {
  return {
    id: asset.id,
    name: asset.name,
    sizeBytes: version.sizeBytes,
    mimeType: version.detectedMimeType,
    updatedAt: asset.updatedAt.toISOString(),
  };
}

function toProjectView(row: ProjectRow): PortalProjectView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    // 'YYYY-MM-DD' strings from the DATE columns (0012), passed through unserialised.
    committedAt: row.committedAt,
    forecastAt: row.forecastAt,
  };
}

/**
 * The internal lifecycle collapsed to what a client is told.
 *
 * Deliberately lossy. `backlog`, `ready`, `in_progress`, `blocked` and `internal_review` all
 * read as "in progress", because the differences between them are internal: a client learning
 * that their deliverable is blocked, and on what, is a conversation somebody at the agency
 * should be having rather than a status a portal leaks.
 *
 * **Terminal state wins over the action audience.** `client_action_required` is an audience,
 * not a lifecycle state, and it is not cleared when an item is finished — a `done` item can
 * still carry it. Deciding the terminal states first means a completed deliverable reads as
 * `done`, never as `waiting_on_you`: the portal must not ask a client to act on work that is
 * already finished or archived. Only a still-open item's audience promotes it to
 * `waiting_on_you`. Exported for the unit suite.
 */
export function progressOf(row: WorkItemRow): PortalWorkItemView['progress'] {
  if (row.state === 'done' || row.state === 'archived') return 'done';
  if (row.audience === 'client_action_required') return 'waiting_on_you';
  return 'in_progress';
}

function toWorkItemView(row: WorkItemRow): PortalWorkItemView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    progress: progressOf(row),
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PortalService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly workItems: WorkItemsRepository = new WorkItemsRepository(),
    private readonly projections: ClientProjectionsRepository = new ClientProjectionsRepository(),
    private readonly files: FileAssetsRepository = new FileAssetsRepository(),
  ) {}

  /**
   * The projects this principal may see through the portal.
   *
   * For a client, that is exactly the projects shared with their client organization —
   * `PrincipalRepository.projectScope` read `project_clients` to build the list and
   * `authorize()` rule 10 refuses anything outside it. For an internal principal it is the
   * projects they are related to, which is how anybody at the agency checks what a client can
   * see without asking the client.
   *
   * ## A page is `limit` *readable* projects, not one repository page minus the unreadable ones
   *
   * `mayRead` is `authorize()`'s relation rule, not a column, so it cannot be pushed into the
   * SQL `WHERE` and runs per row after the query. Filtering a single 50-row page afterwards
   * (R07) let the page limit hide accessible projects: a client whose only shared project was
   * the tenant's 51st received an empty list, because the first page held 50 projects none of
   * which were theirs. The query is now asked for the next page, keyset by the last id seen,
   * until either a full page of readable projects is in hand or the table runs short — the same
   * walk `WorkItemsService.list` uses, bounded by {@link LIST_PAGE_BUDGET}.
   */
  async projectsFor(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly PortalProjectView[]> {
    const limit = projectPageSize(undefined);

    const readable = await this.database.read(context, async (runner) => {
      const collected: ProjectRow[] = [];
      let after: string | undefined;
      for (let pages = 0; pages < LIST_PAGE_BUDGET; pages += 1) {
        const page = await this.projects.list(runner, context, {
          ...(after === undefined ? {} : { after }),
          limit,
        });
        for (const row of page) {
          if (this.mayRead(principal, row.id)) collected.push(row);
        }
        const last = page[page.length - 1];
        if (page.length < limit || collected.length >= limit || last === undefined) break;
        after = last.id;
      }
      return collected.slice(0, limit);
    });

    return readable.map(toProjectView);
  }

  /**
   * The client-facing work in one project, or across all of them.
   *
   * The audience filter is a **query predicate**, not a `.filter()` afterwards. An internal row
   * is never selected, so there is no moment at which this process holds one and has to
   * remember not to return it.
   *
   * The **relation** filter is the part that cannot go in the query — `mayRead` is
   * `authorize()`'s rule about a principal, not a column — so it runs per row, and the walk
   * below keeps asking for the next page until it has a full page of readable rows or the table
   * runs short. Filtering a single page afterwards (R07) let client-visible work in projects the
   * client cannot read fill the page limit and hide the work in projects they can, even when the
   * client had fewer than 50 items of their own. The keyset cursor stays valid across the walk;
   * it is bounded by {@link LIST_PAGE_BUDGET}.
   */
  async workItemsFor(
    context: TenantContext,
    principal: Principal,
    options: { readonly projectId?: string } = {},
  ): Promise<readonly PortalWorkItemView[]> {
    if (options.projectId && !this.mayRead(principal, options.projectId)) {
      // 404, not 403. A client probing project ids must not learn which of them are real.
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const limit = workItemPageSize(undefined);

    const readable = await this.database.read(context, async (runner) => {
      const collected: WorkItemRow[] = [];
      let after: string | undefined;
      for (let pages = 0; pages < LIST_PAGE_BUDGET; pages += 1) {
        const page = await this.workItems.list(runner, context, {
          audiences: CLIENT_AUDIENCES,
          ...(options.projectId ? { projectId: options.projectId } : {}),
          ...(after === undefined ? {} : { after }),
          limit,
        });
        for (const row of page) {
          if (this.mayRead(principal, row.projectId)) collected.push(row);
        }
        const last = page[page.length - 1];
        if (page.length < limit || collected.length >= limit || last === undefined) break;
        after = last.id;
      }
      return collected.slice(0, limit);
    });

    return readable.map(toWorkItemView);
  }

  /**
   * The published deliverable versions the client may see in one project — x114.
   *
   * The relation check runs **first and tenant-scoped** (FAST-PROTOCOL Known trap): `mayRead`
   * is `authorize()`'s rule about this principal and this project, and for a client it refuses
   * any project outside `principal.projectIds` — so an unknown, cross-tenant or not-their-project
   * `projectId` is `404, not_found` here, before any row is read, never a 500. Only then does the
   * query run, and it reads `client_projections` alone: an unpublished deliverable has no row and
   * so is invisible, and every field returned comes from the x97 allowlisted payload.
   */
  async deliverablesFor(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<readonly PortalDeliverableView[]> {
    if (!this.mayRead(principal, projectId)) {
      // 404, not 403. A client probing project ids must not learn which of them are real.
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const rows = await this.database.read(context, (runner) =>
      this.projections.listByProject(runner, context, projectId),
    );
    return rows.map(toDeliverableView);
  }

  /**
   * The client-visible files attached to one client-visible deliverable — x114.
   *
   * Resolution order is the Known trap's: the deliverable is resolved **tenant-scoped first**
   * (`findLatestByDeliverable`, organization-scoped), and a deliverable with no published
   * projection — unknown id, cross-tenant id, or one never published — is absent, which becomes a
   * `404` here. Its project is then run through `mayRead`, so a deliverable in a project this
   * client cannot read (another client's, in the same tenant) is a `404` too. Every refusal is
   * the same not-found, never a 500 and never a 403 a probe could read.
   *
   * The file query is scoped to this client's own organization, so one client never sees
   * another's file even inside a project both can read; it returns only `ready`, client-audience
   * `deliverable` files. This route is for a client member — an internal caller has no single
   * client organization to scope to and is answered `404`, the internal file surface being the
   * studio's own download route.
   */
  async filesForDeliverable(
    context: TenantContext,
    principal: Principal,
    deliverableId: string,
  ): Promise<readonly PortalDeliverableFileView[]> {
    const clientOrganizationId = principal.clientOrganizationId;
    if (!clientOrganizationId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const projection = await this.database.read(context, (runner) =>
      this.projections.findLatestByDeliverable(runner, context, deliverableId),
    );
    if (!projection || !this.mayRead(principal, projection.projectId)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const rows = await this.database.read(context, (runner) =>
      this.files.listClientVisibleForDeliverable(runner, context, {
        deliverableId,
        clientOrganizationId,
      }),
    );
    return rows
      .filter(
        (row): row is { asset: FileAssetRow; version: FileVersionRow } => row.version !== null,
      )
      .map((row) => toDeliverableFileView(row.asset, row.version));
  }

  /**
   * May this principal read the client projection of this project?
   *
   * One call to `authorize()` per row, at audience `client_visible`, which is the audience the
   * projection actually has. For a client principal that runs rules 7 to 10: same client
   * organization, client-readable audience, published, and the project in `projectIds`.
   */
  private mayRead(principal: Principal, projectId: string): boolean {
    return authorize({
      principal,
      capability: 'client_projection.read',
      resource: {
        organizationId: principal.organizationId,
        projectId,
        audience: 'client_visible',
        clientOrganizationId: principal.clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
  }
}
