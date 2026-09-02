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
 * `ClientRequestsService.getForClient`, which refuses a request outside the principal's own
 * client organization and outside the projects shared with it.
 *
 * ## What is different, and why each difference exists
 *
 * - **The bundle carries the client's `status`, not the internal `state`.** `getForClient`
 *   answers with `ClientRequestClientView`, whose `status` collapses `triage` into
 *   `submitted`; this view copies that word and never sees the row. A client reading their
 *   inbox learns what they would learn on `CL-06`, and nothing more.
 * - **Only `client_request` rows resolve.** A client has no authorized read of a work item by
 *   id — `PortalService` lists client-facing work and does not fetch one — so a `work_item`
 *   row addressed to a client (no consumer writes one today) is skipped rather than resolved
 *   through the internal `WorkItemsService.get`, which would be the one thing this file must
 *   never call. Skipped, not errored: the row is real, and a later portal read may know it.
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

export class PortalInboxService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly requests: ClientRequestsService,
    private readonly notifications: NotificationsRepository = new NotificationsRepository(),
  ) {}

  /**
   * The client's inbox, one page of rows bundled by request.
   *
   * The recipient is `principal.userId`. `unread` is a predicate in the query (`read_at IS
   * NULL`), so a page of `limit` rows is a page of matching rows and `nextCursor` means what
   * it says; the only thing a page loses after the read is a bundle whose request this client
   * may no longer see, and that makes the page short, never wrong about the end.
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
      // Only a client request has a client-side authorized read. Anything else addressed to
      // a client is skipped, never resolved through an internal service.
      if (row.objectType !== 'client_request') continue;
      const group = byRequest.get(row.objectId);
      if (group) group.push(row);
      else byRequest.set(row.objectId, [row]);
    }

    const bundles: PortalInboxBundleView[] = [];
    for (const [requestId, group] of byRequest) {
      const first = group[0];
      if (!first) continue;
      const resolved = await this.resolve(context, principal, requestId);
      if (!resolved) continue; // §1's second check: revoked means silent.

      const types: string[] = [];
      for (const row of group) if (!types.includes(row.type)) types.push(row.type);

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
   * The request behind a notification, through the portal's own read. `null` for a 404 —
   * absent, another client's, or in a project no longer shared — and every other failure
   * propagates, because a database fault must not read as "nothing for you".
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
