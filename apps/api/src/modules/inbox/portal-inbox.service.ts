import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { NotificationRow } from '../../common/database/schema.js';
import {
  DEFAULT_NOTIFICATION_PAGE,
  MAX_NOTIFICATION_PAGE,
  NotificationsRepository,
} from './notifications.repository.js';
import type {
  ClientRequestStatus,
  ClientRequestsService,
} from '../requests/client-requests.service.js';

/**
 * INBOX-001, second half — the client's inbox, as a **portal projection**.
 *
 * NOTIF-001's consumers write `client_request.transitioned.v1` rows *to the client who
 * submitted* the request, and the first half's read surface is guarded by `work.read`, which
 * no client role holds. Those rows therefore had no reader: fail-closed, nothing leaked, and
 * nothing seen. This service is their reader, and it is built the way every other client
 * surface is — a path of its own, a projection built field by field, never the internal
 * record with a filter in front (`25-AUTH-AND-TENANT-ISOLATION` §7).
 *
 * ## What is the same as the internal inbox
 *
 * The three rules that make the internal half safe are kept verbatim, because they are the
 * planning's, not that surface's: **recipient only** (`21-REQUIREMENTS-TRACEABILITY` FR-07 —
 * every query names `principal.userId`); **a bundle is one object** (`22-SCREEN-BY-SCREEN`
 * TM-04, the id is `objectType:objectId`); and **the object is resolved at read time through
 * its own authorized read, and a 404 drops the bundle silently** (`35-NOTIFICATION-AND-EMAIL-
 * COPY` §1's second check, `24-EVENT-CATALOG` §6). Here the authorized read is
 * `ClientRequestsService.getManyForClient` for the page (one query since 2026-09-03) and
 * `getForClient` for the one bundle a mark-read reauthorizes; both refuse a request outside
 * the principal's own client organization and outside the projects shared with it.
 *
 * ## What is different, and why each difference exists
 *
 * - **The bundle carries the client's `status`, not the internal `state`.** `getForClient`
 *   answers with `ClientRequestClientView`, whose `status` collapses `triage` into
 *   `submitted`; this view copies that word and never sees the row. A client reading their
 *   inbox learns what they would learn on `CL-06`, and nothing more.
 * - **Only `client_request` rows are read.** A client has no authorized read of a work item by
 *   id — `PortalService` lists client-facing work and does not fetch one — so a `work_item`
 *   row addressed to a client (no consumer writes one today) is never selected: the object
 *   type is a predicate in the query, not a skip after the read, so a page of `limit` rows is
 *   a page of rows this surface can resolve. The bundler still refuses anything else, so the
 *   internal `WorkItemsService.get` — the one thing this file must never call — has no path.
 * - **The event types are allowlisted.** `types` is the only field a row contributes to the
 *   projection directly, and it is an identifier from the internal event catalogue. Only the
 *   types a client is written to about pass through; an unknown one — a producer this half
 *   does not know — is dropped from the list, and the bundle stays. The screen says the type
 *   in words and never prints an identifier.
 * - **Two modes, not four.** `all` and `unread`. `important` and `client_actions` are internal
 *   readings of internal events; a client's inbox has one producer and the only distinction
 *   a client can act on is "have I seen this".
 * - **The principal must be a client.** The route's guard is `client_request.submit`, which
 *   no internal role holds; this service refuses a non-client principal again with its own
 *   403, the way `listForClient` does, so the refusal does not rest on one declaration.
 */

export type PortalInboxMode = 'all' | 'unread';

export const PORTAL_INBOX_MODES: readonly PortalInboxMode[] = ['all', 'unread'];

export function isPortalInboxMode(value: string): value is PortalInboxMode {
  return (PORTAL_INBOX_MODES as readonly string[]).includes(value);
}

/** One request, however many notifications the client has about it. */
export interface PortalInboxBundleView {
  /** `client_request:{id}`. What "mark read" takes. */
  readonly bundleId: string;
  readonly requestId: string;
  readonly projectId: string;
  /** The request's title, read through the portal's own authorized path at request time. */
  readonly title: string;
  /** The client-safe status, as `CL-06` shows it. Never the internal state. */
  readonly status: ClientRequestStatus;
  readonly count: number;
  readonly unreadCount: number;
  /** The event types in this bundle, newest first, each once. */
  readonly types: readonly string[];
  readonly latestAt: string;
  readonly action: { readonly kind: 'open' };
}

export interface PortalInboxPageView {
  readonly items: readonly PortalInboxBundleView[];
  /** The id of the oldest notification row this page bundled, or `null` at the end. */
  readonly nextCursor: string | null;
}

export interface ListPortalInboxOptions {
  readonly mode?: PortalInboxMode;
  readonly before?: string;
  readonly limit?: number;
}

/** The one object type a client can read through the portal. A query predicate, not a skip. */
const PORTAL_OBJECT_TYPES: readonly string[] = ['client_request'];

/** The event types a client is written to about. Anything else is dropped from `types`. */
export const PORTAL_NOTIFICATION_TYPES: readonly string[] = ['client_request.transitioned.v1'];

export class PortalInboxService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly requests: ClientRequestsService,
    private readonly notifications: NotificationsRepository = new NotificationsRepository(),
  ) {}

  /**
   * The client's inbox, one page of rows bundled by request.
   *
   * The recipient is `principal.userId`. `unread` and the object type are predicates in the
   * query (`read_at IS NULL`, `object_type = 'client_request'`), so a page of `limit` rows is
   * a page of matching rows and `nextCursor` means what it says; the only thing a page loses
   * after the read is a bundle whose request this client may no longer see, and that makes
   * the page short, never wrong about the end.
   *
   * In `unread` mode every row is unread, so `count` equals `unreadCount` and is the number
   * of unread notifications about the request, not the number of notifications ever. The
   * screen words the two modes differently for that reason.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: ListPortalInboxOptions = {},
  ): Promise<PortalInboxPageView> {
    assertClient(principal);

    const mode = options.mode ?? 'all';
    const limit = Math.min(
      Math.max(options.limit ?? DEFAULT_NOTIFICATION_PAGE, 1),
      MAX_NOTIFICATION_PAGE,
    );

    const rows = await this.database.read(context, (runner) =>
      this.notifications.listForRecipient(runner, context, principal.userId, {
        limit,
        objectTypes: PORTAL_OBJECT_TYPES,
        ...(options.before === undefined ? {} : { before: options.before }),
        ...(mode === 'unread' ? { unreadOnly: true } : {}),
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
   * Mark every row of one bundle read, for this client only — reauthorized first.
   *
   * The request is read through `getForClient` **before** anything is written: a client whose
   * organization lost the project share cannot even mark its notifications read. The answer
   * is the same 404 the list would have hidden the bundle behind.
   */
  async markBundleRead(
    context: TenantContext,
    principal: Principal,
    bundleId: string,
  ): Promise<{ readonly bundleId: string; readonly marked: number }> {
    assertClient(principal);

    const requestId = parseBundleId(bundleId);
    if (!requestId) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    const resolved = await this.resolve(context, principal, requestId);
    if (!resolved) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    const marked = await this.database.transaction(context, (tx) =>
      this.notifications.markRead(tx, context, principal.userId, {
        objectType: 'client_request',
        objectId: requestId,
      }),
    );
    return { bundleId, marked };
  }

  private async bundle(
    context: TenantContext,
    principal: Principal,
    rows: readonly NotificationRow[],
  ): Promise<readonly PortalInboxBundleView[]> {
    // Newest first is the row order; a Map keeps insertion order, so the first row seen for a
    // request is its latest and the bundle order is "most recently touched first".
    const byRequest = new Map<string, NotificationRow[]>();
    for (const row of rows) {
      // The query already restricted the object type; this is the bundler refusing to resolve
      // anything else through an internal service, should the query ever stop doing so.
      if (row.objectType !== 'client_request') continue;
      const group = byRequest.get(row.objectId);
      if (group) group.push(row);
      else byRequest.set(row.objectId, [row]);
    }

    // One authorized read for the page's requests, not one per bundle. Until 2026-09-03 each
    // bundle called `getForClient` in turn — a hundred bundles, a hundred round trips.
    // `getManyForClient` applies the same `mayClientRead` and leaves out what `getForClient`
    // would have refused, so the silence below is the same silence.
    const requests = await this.requests.getManyForClient(context, principal, [
      ...byRequest.keys(),
    ]);

    const bundles: PortalInboxBundleView[] = [];
    for (const [requestId, group] of byRequest) {
      const first = group[0];
      if (!first) continue;
      const view = requests.get(requestId);
      if (!view) continue; // §1's second check: revoked means silent.
      // Field by field from the client view. Nothing here has ever seen the row.
      const resolved = { title: view.title, status: view.status, projectId: view.projectId };

      const types: string[] = [];
      for (const row of group) {
        if (PORTAL_NOTIFICATION_TYPES.includes(row.type) && !types.includes(row.type)) {
          types.push(row.type);
        }
      }

      bundles.push({
        bundleId: `client_request:${requestId}`,
        requestId,
        projectId: resolved.projectId,
        title: resolved.title,
        status: resolved.status,
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
   * The request behind one notification, through the portal's own read — `markBundleRead`'s
   * reauthorization. `null` for a 404 — absent, another client's, or in a project no longer
   * shared — and every other failure propagates, because a database fault must not read as
   * "nothing for you".
   */
  private async resolve(
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<{
    readonly title: string;
    readonly status: ClientRequestStatus;
    readonly projectId: string;
  } | null> {
    try {
      const view = await this.requests.getForClient(context, principal, requestId);
      // Field by field from the client view. Nothing here has ever seen the row.
      return { title: view.title, status: view.status, projectId: view.projectId };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }
}

function assertClient(principal: Principal): void {
  if (principal.kind !== 'client' || !principal.clientOrganizationId) {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'not_a_client_principal');
  }
}

/** `client_request:{id}` and nothing else. The portal has no other bundle kind. */
function parseBundleId(bundleId: string): string | null {
  const prefix = 'client_request:';
  if (!bundleId.startsWith(prefix)) return null;
  const requestId = bundleId.slice(prefix.length);
  return requestId === '' ? null : requestId;
}
