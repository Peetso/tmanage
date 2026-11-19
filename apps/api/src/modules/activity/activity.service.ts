import {
  ACTIVITY_ACTION_CATALOG,
  authorize,
  isActivityAction,
  type ActivityAction,
  type ActivityActionDefinition,
  type ActivityKind,
  type ActivitySource,
  type Principal,
} from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { ProjectRow } from '../../common/database/schema.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ClientOrganizationsRepository } from '../clients/client-organizations.repository.js';
import { ProjectClientsRepository } from '../clients/project-clients.repository.js';
import {
  ActivityRepository,
  type ActivityEntryRow,
  type ActivityFilter,
  type ActivityKey,
  type ActivityScope,
  type ActivitySourceFacts,
  type FactSource,
} from './activity.repository.js';
import { factKeyOf, factSourceOf, mayReadEntry } from './activity-resolver.js';
import { activityPhrase } from './activity-phrases.js';

/**
 * 62-A2 (B02) — the Activity tab of a project and of a client: what happened, newest first.
 *
 * ## Parent first, then every entry
 *
 * The project (or client) named in the path is read tenant-scoped and authorised **before** a
 * single entry is read — the work-item feed's rule: a project the caller may not read, or another
 * tenant's, is the same 404 a missing one gives, and no `activity_entries` row is touched. The
 * project feed needs `work.read` on the project; the client feed needs `org.manage` (the client
 * page's own gate). Then each entry is re-checked through its source row's read rule
 * (`activity-resolver.ts`): an entry whose row was deleted, or that this person may not read now
 * (an internal task of a project they are not on, a finance entry without `finance.view`), is
 * dropped. A dropped entry leaves no trace in the page, and the page is refilled from older rows.
 *
 * ## The page
 *
 * Keyset, newest first, `limit` entries (default {@link DEFAULT_ACTIVITY_PAGE}, at most
 * {@link MAX_ACTIVITY_PAGE}). Because entries can be dropped, a page reads at most
 * {@link SCAN_ROUNDS} batches; `nextCursor` is the position of the last row looked at, so a dropped
 * row is never looked at twice. Filters: kind, person, date range.
 *
 * The first page also says how many entries the viewer may read in all (`total`, "Showing 25 of
 * 46"), counted by the same per-entry rule over at most {@link TOTAL_SCAN_CAP} rows, so the count
 * never includes an entry the viewer could not open; past the cap it is a lower bound (`atLeast`).
 *
 * Entries are phrases built from the action (`activity-phrases.ts`) and, where the row has one,
 * its current name (`subject`, D2) — read with the facts that gate it, so a name only ever reaches a
 * viewer who may read its row. Never a body or an amount.
 */

export const ACTIVITY_SERVICE = Symbol.for('tmanage.ActivityService');

export const DEFAULT_ACTIVITY_PAGE = 50;
export const MAX_ACTIVITY_PAGE = 100;
const SCAN_ROUNDS = 4;
/** The most rows the first page's `total` looks at; beyond it the total is "at least". */
export const TOTAL_SCAN_CAP = 1_000;
/** The most shared projects a client feed spans (page size of `ProjectClientsRepository`). */
const CLIENT_PROJECT_PAGE = 200;
const CLIENT_PROJECT_CAP = 1_000;

/**
 * One entry of an Activity tab. Paired `Exact` with the web `ActivityEntry` in `e2e/contracts`.
 * `actorUserId` is null for a system action; the screen shows the person's name from it.
 */
export interface ActivityEntryView {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly action: ActivityAction;
  readonly phraseKey: string;
  readonly summary: string;
  /** The record's name now (task title, file name, invoice number); `null` when it has none. */
  readonly subject: string | null;
  readonly actorUserId: string | null;
  readonly objectType: ActivitySource;
  readonly objectId: string;
  readonly projectId: string | null;
  readonly clientOrganizationId: string | null;
  readonly occurredAt: string;
}

/** How many entries the viewer may read under the filters; `atLeast` past the scan cap. */
export interface ActivityTotalView {
  readonly count: number;
  readonly atLeast: boolean;
}

export interface ActivityPageView {
  readonly entries: readonly ActivityEntryView[];
  /** Pass back as `cursor` for older entries; `null` when there are none. */
  readonly nextCursor: string | null;
  /** On the first page only (no `cursor`); `null` on the pages after it. */
  readonly total: ActivityTotalView | null;
}

export interface ActivityQuery extends ActivityFilter {
  readonly cursor?: string;
  readonly limit?: number;
}

export class ActivityService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly activity: ActivityRepository = new ActivityRepository(),
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly clients: ClientOrganizationsRepository = new ClientOrganizationsRepository(),
    private readonly shares: ProjectClientsRepository = new ProjectClientsRepository(),
  ) {}

  async projectActivity(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    query: ActivityQuery = {},
  ): Promise<ActivityPageView> {
    return this.database.read(context, async (runner) => {
      const project = await this.projects.findById(runner, context, projectId);
      if (!project || !mayReadProject(principal, project)) throw notFound('project_not_visible');
      return this.page(runner, context, principal, { kind: 'project', projectId }, query);
    });
  }

  async clientActivity(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
    query: ActivityQuery = {},
  ): Promise<ActivityPageView> {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      // A client organization is an org-level resource: no project may stand in for the gate.
      resource: { organizationId: context.organizationId, projectId: null, audience: 'internal' },
    });
    if (!verdict.allowed) throw notFound(verdict.code);
    return this.database.read(context, async (runner) => {
      const client = await this.clients.findById(runner, context, clientOrganizationId);
      if (!client) throw notFound('client_organization_not_found');
      const projectIds = await this.sharedProjectIds(runner, context, clientOrganizationId);
      const scope: ActivityScope = { kind: 'client', clientOrganizationId, projectIds };
      return this.page(runner, context, principal, scope, query);
    });
  }

  private async sharedProjectIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientOrganizationId: string,
  ): Promise<readonly string[]> {
    const ids: string[] = [];
    let after: string | undefined;
    while (ids.length < CLIENT_PROJECT_CAP) {
      const rows = await this.shares.list(runner, context, {
        clientOrganizationId,
        limit: CLIENT_PROJECT_PAGE,
        ...(after === undefined ? {} : { after }),
      });
      ids.push(...rows.map((row) => row.projectId));
      if (rows.length < CLIENT_PROJECT_PAGE) break;
      after = rows.at(-1)?.id;
    }
    return ids;
  }

  private async page(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    scope: ActivityScope,
    query: ActivityQuery,
  ): Promise<ActivityPageView> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_ACTIVITY_PAGE, 1), MAX_ACTIVITY_PAGE);
    const filter: ActivityFilter = {
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.actorUserId === undefined ? {} : { actorUserId: query.actorUserId }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
    };
    let position = query.cursor === undefined ? null : decodeActivityCursor(query.cursor);
    const entries: ActivityEntryView[] = [];
    let more = true;
    for (let round = 0; round < SCAN_ROUNDS && more && entries.length < limit; round += 1) {
      const rows = await this.activity.listEntries(runner, context, scope, filter, position, limit);
      more = rows.length === limit;
      const readable = await this.readable(runner, context, principal, rows);
      for (const [index, row] of rows.entries()) {
        position = { occurredAt: row.occurredAt, id: row.id };
        const view = readable.get(row.id);
        if (view !== undefined) entries.push(view);
        if (entries.length === limit) {
          more = more || index < rows.length - 1;
          break;
        }
      }
    }
    const nextCursor = more && position !== null ? encodeActivityCursor(position) : null;
    const total =
      query.cursor !== undefined
        ? null
        : nextCursor === null
          ? { count: entries.length, atLeast: false }
          : await this.total(runner, context, principal, scope, filter);
    return { entries, nextCursor, total };
  }

  /** The readable entries under `filter`, by the same rule as the page, over the newest rows. */
  private async total(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    scope: ActivityScope,
    filter: ActivityFilter,
  ): Promise<ActivityTotalView> {
    const rows = await this.activity.listEntries(
      runner,
      context,
      scope,
      filter,
      null,
      TOTAL_SCAN_CAP + 1,
    );
    const looked = rows.slice(0, TOTAL_SCAN_CAP);
    const readable = await this.readable(runner, context, principal, looked);
    return { count: readable.size, atLeast: rows.length > TOTAL_SCAN_CAP };
  }

  /** The views of the rows this principal may read now, by entry id. */
  private async readable(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    rows: readonly ActivityEntryRow[],
  ): Promise<ReadonlyMap<string, ActivityEntryView>> {
    const entries = rows.flatMap((row) => {
      const found = catalogued(row);
      return found === null ? [] : [found];
    });
    const wanted = new Map<FactSource, Set<string>>();
    for (const { factSource, factKey } of entries) {
      const ids = wanted.get(factSource) ?? new Set<string>();
      ids.add(factKey);
      wanted.set(factSource, ids);
    }
    const facts = new Map<FactSource, ReadonlyMap<string, ActivitySourceFacts>>();
    for (const [source, ids] of wanted) {
      facts.set(source, await this.activity.sourceFacts(runner, context, source, [...ids]));
    }
    const views = new Map<string, ActivityEntryView>();
    for (const { row, action, definition, factSource, factKey } of entries) {
      const found = facts.get(factSource)?.get(factKey);
      if (found === undefined) continue;
      const { source, finance } = definition;
      if (!mayReadEntry(principal, context.organizationId, source, finance, found)) continue;
      views.set(row.id, toView(row, action, definition, found.subject));
    }
    return views;
  }
}

/** A row whose action is still catalogued, with where its read facts come from. */
interface CataloguedEntry {
  readonly row: ActivityEntryRow;
  readonly action: ActivityAction;
  readonly definition: ActivityActionDefinition;
  readonly factSource: FactSource;
  readonly factKey: string;
}

function catalogued(row: ActivityEntryRow): CataloguedEntry | null {
  if (!isActivityAction(row.action)) return null;
  const action = row.action;
  const definition = ACTIVITY_ACTION_CATALOG[action];
  const factKey = factKeyOf(definition.source, row);
  if (factKey === null) return null;
  return { row, action, definition, factSource: factSourceOf(definition.source), factKey };
}

function toView(
  row: ActivityEntryRow,
  action: ActivityAction,
  definition: ActivityActionDefinition,
  subject: string | null,
): ActivityEntryView {
  return {
    id: row.id,
    kind: definition.kind,
    action,
    ...activityPhrase(action, subject),
    actorUserId: row.actorUserId,
    objectType: definition.source,
    objectId: row.objectId,
    projectId: row.projectId,
    clientOrganizationId: row.clientOrganizationId,
    occurredAt: row.occurredAt.toISOString(),
  };
}

function mayReadProject(principal: Principal, row: ProjectRow): boolean {
  return authorize({
    principal,
    capability: 'work.read',
    resource: {
      organizationId: row.organizationId,
      projectId: row.id,
      audience: 'internal',
      lifecycle: row.archivedAt ? 'archived' : 'active',
    },
  }).allowed;
}

function notFound(auditCode: string): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, auditCode);
}

const CURSOR_SEPARATOR = '|';

/** An opaque page position: base64url of `<occurredAt ISO>|<entry id>`. */
export function encodeActivityCursor(key: ActivityKey): string {
  return Buffer.from(`${key.occurredAt.toISOString()}${CURSOR_SEPARATOR}${key.id}`).toString(
    'base64url',
  );
}

/** The position a cursor names; a malformed cursor is a 400, never a full read. */
export function decodeActivityCursor(token: string): ActivityKey {
  const text = Buffer.from(token, 'base64url').toString('utf8');
  const [at, id, ...rest] = text.split(CURSOR_SEPARATOR);
  const occurredAt = new Date(at ?? '');
  if (
    rest.length > 0 ||
    id === undefined ||
    !/^[0-9a-f-]{36}$/.test(id) ||
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.toISOString() !== at
  ) {
    throw new ApiError(400, 'validation_failed', 'cursor is not valid', [
      { field: 'cursor', message: 'is not a cursor this feed issued' },
    ]);
  }
  return { occurredAt, id };
}
