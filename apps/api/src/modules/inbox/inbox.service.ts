import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { NotificationRow } from '../../common/database/schema.js';
import {
  DEFAULT_NOTIFICATION_PAGE,
  MAX_NOTIFICATION_PAGE,
  NotificationsRepository,
} from './notifications.repository.js';
import type { ClientRequestsService } from '../requests/client-requests.service.js';
import type { WorkItemsService } from '../work/work-items.service.js';
import {
  STORAGE_BYTES_METRIC,
  UsageCountersRepository,
} from '../files/usage-counters.repository.js';

/**
 * INBOX-001, first half — the read surface over NOTIF-001's rows, as **bundles**.
 *
 * `22-SCREEN-BY-SCREEN` TM-04: "Bundles show count, latest time, required action. Inline
 * actions reauthorize at execution." `35-NOTIFICATION-AND-EMAIL-COPY` §1: "Access is checked
 * when notification is generated and again when link/action opens." Three decisions follow,
 * and each is the shape of a method here rather than a sentence in a comment:
 *
 * 1. **A notification carries no content, so the inbox resolves the object at read time.**
 *    The row is a reference envelope — type, object type, object id — by NOTIF-001's design,
 *    because a notification outlives the access decision that allowed it. This service turns
 *    the reference back into a title by calling the ordinary authorized read for the object
 *    (`WorkItemsService.get`, `ClientRequestsService.get`), and a **404 from that read drops
 *    the bundle silently**. That is §1's second check: a person whose access was revoked
 *    between the event and their next visit sees nothing, not a title they may no longer
 *    read, and not a "you cannot see this" that confirms the object exists.
 * 2. **A bundle is one object.** Five rows about the same work item are one line with a
 *    count, `35` §4's "`{project} · {count} updates`" without the project, which no row
 *    carries. The bundle id is `objectType:objectId`, which is also what "mark read" takes —
 *    the inline action is scoped to the recipient's own rows about that object and nothing
 *    else.
 * 3. **The modes are the ones the planning names, read literally.** `all` is everything;
 *    `waiting_on_me` is what is unread; `client_actions` is what a client did (a submitted
 *    request); `important` is `35` §2's "Important update: blocker affecting recipient" — a
 *    bundle carrying `work_item.blocked.v1`. No ranking, no scoring: "why important" on this
 *    surface is the type of the event, said in words by the screen.
 *
 * ## What is deliberately not here
 *
 * Quiet hours, digests and channel choice need preferences, which the contract draws no
 * table for — NOTIF-001's first named gap, unchanged. Bundles split at page boundaries: a
 * page is `limit` rows, bundled, and an object whose rows straddle two pages appears on both
 * — the screen merges the two appearances by bundle id, so a reader sees one row. Read state
 * syncs across devices by being a column, which TM-04 asks for; "bulk mark read reversible
 * for a short interval" is not built — the trigger makes a read row permanent.
 *
 * ## One read per object type, not one per bundle
 *
 * Until 2026-09-03 each bundle's object was resolved by its own `get`, in sequence — a page
 * of a hundred distinct objects was a hundred-odd round trips, recorded twice as the right
 * shape to change. Now the page's ids are collected by object type and resolved together
 * through `WorkItemsService.getMany` and `ClientRequestsService.getMany`, which apply the
 * same `mayRead` / `mayTriage` `get` applies and leave out what `get` would have refused.
 * Decision 1 is unchanged: a missing entry drops the bundle, silently. Only the count of
 * queries moved. `markBundleRead` still reads its one object through `get`.
 */

export type InboxMode = 'important' | 'all' | 'waiting_on_me' | 'client_actions';

export const INBOX_MODES: readonly InboxMode[] = [
  'important',
  'all',
  'waiting_on_me',
  'client_actions',
];

export function isInboxMode(value: string): value is InboxMode {
  return (INBOX_MODES as readonly string[]).includes(value);
}

/** One object, however many notifications about it. */
export interface InboxBundleView {
  /** `objectType:objectId`. What "mark read" takes. */
  readonly bundleId: string;
  readonly objectType: 'work_item' | 'client_request';
  readonly objectId: string;
  /** The object's title, read through the authorized path at the time of this request. */
  readonly title: string;
  /** The object's current state, from the same read. */
  readonly state: string;
  readonly projectId: string;
  readonly count: number;
  readonly unreadCount: number;
  /** The event types in this bundle, newest first, each once. */
  readonly types: readonly string[];
  readonly latestAt: string;
  /** `openapi.yaml`'s `action` — what the screen offers. Reauthorized when it is taken. */
  readonly action: { readonly kind: 'open' };
}

/**
 * USAGE-001 slice 4b's read side — a `usage.threshold_reached.v1` notice, resolved to the
 * organization's live storage counters at read time. The notification row is a reference
 * envelope (`organization_usage:organizationId`); the band %, and the used+reserved-of-quota
 * bytes the copy shows, are read here from the usage counter, exactly as a work-item bundle
 * reads its title. Owner/admin-only by construction — the worker consumer
 * (`usage-threshold-notice.ts`) wrote the row only to org-wide owner/org_admin recipients, and
 * the list already filters to `principal.userId` — and tenant-scoped: a notice whose object id
 * is not this tenant's organization is dropped, never rendered.
 */
export interface InboxUsageNoticeView {
  /** `organization_usage:organizationId`. */
  readonly bundleId: string;
  readonly objectType: 'organization_usage';
  /** The organization whose usage this is — always the caller's own tenant. */
  readonly objectId: string;
  /** The threshold band the counter is in: 0, 70, 85, 95 or 100. */
  readonly band: number;
  /** Bytes committed. */
  readonly used: number;
  /** Bytes reserved and not yet committed. */
  readonly reserved: number;
  /** The effective storage quota in bytes. */
  readonly quota: number;
  readonly count: number;
  readonly unreadCount: number;
  readonly latestAt: string;
}

/** A page carries object bundles and — for owners/admins — the organization's usage notice. */
export type InboxItemView = InboxBundleView | InboxUsageNoticeView;

/** Narrow a page item to an object bundle (work item or client request). */
export function isInboxBundleView(item: InboxItemView): item is InboxBundleView {
  return item.objectType === 'work_item' || item.objectType === 'client_request';
}

export interface InboxPageView {
  readonly items: readonly InboxItemView[];
  /** The id of the oldest notification row this page bundled, or `null` at the end. */
  readonly nextCursor: string | null;
}

export interface ListInboxOptions {
  readonly mode?: InboxMode;
  readonly before?: string;
  readonly limit?: number;
}

/** What the inbox keeps of an object it resolved: the three fields a bundle shows. */
interface ResolvedObject {
  readonly title: string;
  readonly state: string;
  readonly projectId: string;
}

const BLOCKED_TYPE = 'work_item.blocked.v1';
const CLIENT_ACTION_TYPES: readonly string[] = ['client_request.submitted.v1'];

/**
 * How the inbox reads the organization's storage usage for a `usage.threshold_reached.v1`
 * notice. `quotaBytes` is the effective quota — the same number `files` service's
 * `storageLimitsFor` hands the reservation guard (config today, ENT-001's entitlement row
 * later). Absent, the inbox has no usage read wired and drops `organization_usage` notices
 * gracefully, exactly as it drops any objectType it cannot resolve.
 */
export interface InboxUsageConfig {
  readonly quotaBytes: number;
  readonly counters?: UsageCountersRepository;
}

export class InboxService {
  private readonly usageCounters: UsageCountersRepository;

  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsService,
    private readonly requests: ClientRequestsService,
    private readonly notifications: NotificationsRepository = new NotificationsRepository(),
    private readonly usage?: InboxUsageConfig,
  ) {
    this.usageCounters = usage?.counters ?? new UsageCountersRepository();
  }

  /**
   * The recipient's inbox, one page of rows bundled by object.
   *
   * The recipient is `principal.userId` and nothing a request can name. `waiting_on_me` is
   * pushed into the query as `unreadOnly`, `important` and `client_actions` as `types`. The
   * first cut filtered the last two after the read, which let a page be "nothing" with a
   * cursor beneath it; the review fleet caught that on 2026-09-02.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: ListInboxOptions = {},
  ): Promise<InboxPageView> {
    const mode = options.mode ?? 'all';
    const limit = Math.min(
      Math.max(options.limit ?? DEFAULT_NOTIFICATION_PAGE, 1),
      MAX_NOTIFICATION_PAGE,
    );

    // Every mode is a predicate in the query, so a page of `limit` rows is a page of
    // matching rows and `nextCursor` means what it says. The one thing a page can still lose
    // after the read is a bundle whose object this person may no longer see — §1's second
    // check — and that makes a page short, never a page that lies about the end.
    const rows = await this.database.read(context, (runner) =>
      this.notifications.listForRecipient(runner, context, principal.userId, {
        limit,
        ...(options.before === undefined ? {} : { before: options.before }),
        ...(mode === 'waiting_on_me' ? { unreadOnly: true } : {}),
        ...(mode === 'important' ? { types: [BLOCKED_TYPE] } : {}),
        ...(mode === 'client_actions' ? { types: CLIENT_ACTION_TYPES } : {}),
      }),
    );

    const items = await this.bundle(context, principal, rows);

    const oldest = rows[rows.length - 1];
    return {
      items,
      nextCursor: rows.length === limit && oldest ? oldest.id : null,
    };
  }

  /**
   * The inline action: mark every row of one bundle read, for this recipient only.
   *
   * Reauthorized at execution, as TM-04 asks: the object is read through its own authorized
   * `get` — the rule the list's batched read applies — **before** anything is written, so a
   * person whose access to the object
   * has gone cannot even mark its notifications read — the bundle is not theirs to see, and
   * the answer is the same 404 the list would have hidden it behind.
   */
  async markBundleRead(
    context: TenantContext,
    principal: Principal,
    bundleId: string,
  ): Promise<{ readonly bundleId: string; readonly marked: number }> {
    const parsed = parseBundleId(bundleId);
    if (!parsed) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    const resolved = await this.resolve(context, principal, parsed.objectType, parsed.objectId);
    if (!resolved) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    const marked = await this.database.transaction(context, (tx) =>
      this.notifications.markRead(tx, context, principal.userId, parsed),
    );
    return { bundleId, marked };
  }

  private async bundle(
    context: TenantContext,
    principal: Principal,
    rows: readonly NotificationRow[],
  ): Promise<readonly InboxItemView[]> {
    // Newest first is the row order; a Map keeps insertion order, so the first row seen for
    // an object is its latest and the bundle order is "most recently touched first".
    const byObject = new Map<string, NotificationRow[]>();
    for (const row of rows) {
      const key = `${row.objectType}:${row.objectId}`;
      const group = byObject.get(key);
      if (group) group.push(row);
      else byObject.set(key, [row]);
    }

    // The page's objects, by type, resolved together: one authorized read per type.
    const workItemIds: string[] = [];
    const requestIds: string[] = [];
    for (const group of byObject.values()) {
      const first = group[0];
      if (!first) continue;
      if (first.objectType === 'work_item') workItemIds.push(first.objectId);
      else if (first.objectType === 'client_request') requestIds.push(first.objectId);
    }
    const objects = await this.resolveMany(context, principal, workItemIds, requestIds);

    // USAGE-001 slice 4b: if any group is the organization's usage notice, resolve its live
    // counters once (there is one usage counter per organization). Skipped entirely when the
    // usage read is not wired.
    const wantsUsage =
      this.usage !== undefined &&
      [...byObject.values()].some((group) => group[0]?.objectType === 'organization_usage');
    const usage = wantsUsage ? await this.resolveUsage(context) : null;

    const bundles: InboxItemView[] = [];
    for (const [bundleId, group] of byObject) {
      const first = group[0];
      if (!first) continue;
      const objectType = first.objectType;

      if (objectType === 'organization_usage') {
        // The recipient is an org-wide owner/admin by construction (the worker wrote the row
        // only to them, and the list already filters to this principal). Still refuse
        // cross-tenant: a notice whose object is not this tenant's organization is never
        // rendered. `usage === null` means no counter row (nothing to show) — dropped like a
        // revoked object, silently.
        if (!this.usage || usage === null) continue;
        if (first.objectId !== context.organizationId) continue;
        bundles.push({
          bundleId,
          objectType: 'organization_usage',
          objectId: first.objectId,
          band: usage.band,
          used: usage.used,
          reserved: usage.reserved,
          quota: this.usage.quotaBytes,
          count: group.length,
          unreadCount: group.filter((row) => row.readAt === null).length,
          latestAt: first.createdAt.toISOString(),
        });
        continue;
      }

      if (objectType !== 'work_item' && objectType !== 'client_request') {
        // A type this surface cannot resolve — a producer this half does not know. Skipped
        // rather than rendered as an id, and not an error: the row is real and someone else's
        // reader may know it.
        continue;
      }
      const resolved = objects.get(bundleId);
      if (!resolved) continue; // §1's second check: revoked means silent.

      const types: string[] = [];
      for (const row of group) if (!types.includes(row.type)) types.push(row.type);

      bundles.push({
        bundleId,
        objectType,
        objectId: first.objectId,
        title: resolved.title,
        state: resolved.state,
        projectId: resolved.projectId,
        count: group.length,
        unreadCount: group.filter((row) => row.readAt === null).length,
        types,
        latestAt: first.createdAt.toISOString(),
        action: { kind: 'open' },
      });
    }
    return bundles;
  }

  /**
   * A page's objects, through the batched authorized reads, keyed by bundle id. An object
   * absent, deleted, or no longer this person's to see is absent from the map — the same
   * silence {@link resolve} answers with `null` — and every other failure propagates, because
   * a database fault must not read as "nothing for you".
   */
  private async resolveMany(
    context: TenantContext,
    principal: Principal,
    workItemIds: readonly string[],
    requestIds: readonly string[],
  ): Promise<ReadonlyMap<string, ResolvedObject>> {
    const objects = new Map<string, ResolvedObject>();
    if (workItemIds.length > 0) {
      const views = await this.workItems.getMany(context, principal, workItemIds);
      for (const [id, view] of views) {
        objects.set(`work_item:${id}`, {
          title: view.title,
          state: view.state,
          projectId: view.projectId,
        });
      }
    }
    if (requestIds.length > 0) {
      const views = await this.requests.getMany(context, principal, requestIds);
      for (const [id, view] of views) {
        objects.set(`client_request:${id}`, {
          title: view.title,
          state: view.state,
          projectId: view.projectId,
        });
      }
    }
    return objects;
  }

  /**
   * The organization's storage counters — USAGE-001 slice 4b's read side. Tenant-scoped
   * through {@link UsageCountersRepository.find} (its `WHERE` names `context.organizationId`),
   * so it can only ever read the caller's own organization. `null` when the organization has
   * no counter row for the storage metric — nothing has been uploaded, so there is nothing to
   * render.
   */
  private async resolveUsage(
    context: TenantContext,
  ): Promise<{ readonly used: number; readonly reserved: number; readonly band: number } | null> {
    const row = await this.database.read(context, (runner) =>
      this.usageCounters.find(runner, context, STORAGE_BYTES_METRIC),
    );
    if (!row) return null;
    return {
      used: Number(row.usedValue),
      reserved: Number(row.reservedValue),
      band: Number(row.thresholdBand),
    };
  }

  /**
   * The object behind one notification, through its own authorized read — `markBundleRead`'s
   * reauthorization. `null` for a 404 — absent, deleted, or no longer this person's to see —
   * and every other failure propagates, because a database fault must not read as "nothing
   * for you".
   */
  private async resolve(
    context: TenantContext,
    principal: Principal,
    objectType: 'work_item' | 'client_request',
    objectId: string,
  ): Promise<ResolvedObject | null> {
    try {
      if (objectType === 'work_item') {
        const view = await this.workItems.get(context, principal, objectId);
        return { title: view.title, state: view.state, projectId: view.projectId };
      }
      const view = await this.requests.get(context, principal, objectId);
      return { title: view.title, state: view.state, projectId: view.projectId };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }
}

function parseBundleId(
  bundleId: string,
): { readonly objectType: 'work_item' | 'client_request'; readonly objectId: string } | null {
  const separator = bundleId.indexOf(':');
  if (separator <= 0) return null;
  const objectType = bundleId.slice(0, separator);
  const objectId = bundleId.slice(separator + 1);
  if (objectType !== 'work_item' && objectType !== 'client_request') return null;
  if (objectId === '') return null;
  return { objectType, objectId };
}
