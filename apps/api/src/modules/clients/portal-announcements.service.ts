import { authorize } from '@tmanage/domain';
import type { DenialCode, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { PortalAnnouncementRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ClientOrganizationsRepository } from './client-organizations.repository.js';
import { PortalAnnouncementsRepository } from './portal-announcements.repository.js';

/**
 * POR client portal (x304) — the internal create/delete surface and the client read for a **pinned
 * announcement banner** shown inside one client organization's portal.
 *
 * Distinct from the portal updates feed (0041, a post stream) and from org-wide admin announcements:
 * this is a banner scoped to one `client_id`, live only within an active window. `12-PERMISSION-MATRIX`
 * §1-2 places the write behind `client_member.manage` (the internal staffer curating a client's
 * relationship) and the read behind `client_projection.read` (the portal side).
 *
 * ## Resolve the client organization, tenant-scoped, BEFORE authorizing or writing
 *
 * Every route names `clientId`. The client organization is resolved first, scoped to the acting tenant
 * ({@link ClientOrganizationsRepository.findById}) — a client id from another tenant does not resolve
 * and the refusal is **404, not 403**, so a caller cannot learn which client ids are real (the Known
 * trap: a cross-tenant id is a 404 with no write). Only then is the capability checked against that
 * client organization. A role that does not hold the capability at all is a **403** (the route
 * ceiling); a client principal that holds it but is scoped to a *different* client organization is a
 * **404**, because it must not learn the id exists.
 *
 * ## Created and retracted, never edited
 *
 * The writes are INSERT (post) and DELETE (retract). `users.sql` withholds UPDATE, so there is no edit
 * path — the `doc_bookmarks` posture. A DELETE is idempotent: retracting a banner that is already gone
 * (or was never this client's) is still a success, not a 404, so a repeated retract is safe.
 */

/** `portal_announcements.title` is `VARCHAR(300)`; `body` is `TEXT` and bounded to a sane maximum. */
export const MAX_PORTAL_ANNOUNCEMENT_TITLE_LENGTH = 300;
export const MAX_PORTAL_ANNOUNCEMENT_BODY_LENGTH = 5000;

/**
 * A banner as an **internal** staffer is shown it — the full record behind `client_member.manage`,
 * returned by create. Carries `createdBy`: an internal curator may see who posted it. This view never
 * leaves the internal write path. Paired against the web type in `e2e/contracts`.
 */
export interface PortalAnnouncementView {
  readonly id: string;
  readonly clientId: string;
  readonly title: string;
  readonly body: string;
  /** ISO-8601 instants on the wire. */
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

/**
 * A banner as a **client** is shown it — the client projection.
 *
 * **`createdBy` is not here.** `12-PERMISSION-MATRIX` §4 excludes staff from the client projection —
 * which member of the agency pinned the banner is an internal fact a client never learns. Listing the
 * fields means a column added to `portal_announcements` tomorrow is invisible to a client until someone
 * decides otherwise.
 */
export interface ClientPortalAnnouncementView {
  readonly id: string;
  readonly clientId: string;
  readonly title: string;
  readonly body: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
}

/** What an internal staffer posts. The tenant and the author come from the context, never the body. */
export interface CreatePortalAnnouncementServiceInput {
  readonly title: string;
  readonly body: string;
  /** Omitted means "live now". */
  readonly startsAt?: Date;
  /** `null` (or omitted) means open-ended. */
  readonly endsAt?: Date | null;
}

function toInternalView(row: PortalAnnouncementRow): PortalAnnouncementView {
  return {
    id: row.id,
    clientId: row.clientId,
    title: row.title,
    body: row.body,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function toClientView(row: PortalAnnouncementRow): ClientPortalAnnouncementView {
  return {
    id: row.id,
    clientId: row.clientId,
    title: row.title,
    body: row.body,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
  };
}

export class PortalAnnouncementsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly clients: ClientOrganizationsRepository = new ClientOrganizationsRepository(),
    private readonly announcements: PortalAnnouncementsRepository = new PortalAnnouncementsRepository(),
    /** Injectable so a test can pin "now" for the active-window read. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Post a banner to a client's portal — internal, `client_member.manage`.
   *
   * The client organization is resolved tenant-scoped **before** authorize or write (404 on a
   * cross-tenant id, no write), then the capability is checked against it. `endsAt <= startsAt` and an
   * empty title are 400s that never reach the insert. The author is `context.userId`, never a field.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    clientId: string,
    input: CreatePortalAnnouncementServiceInput,
  ): Promise<PortalAnnouncementView> {
    const startsAt = input.startsAt ?? this.now();
    const endsAt = input.endsAt ?? null;
    if (endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'endsAt', message: 'must be after startsAt' },
      ]);
    }

    await this.resolveClient(context, clientId);
    this.authorizeManage(principal, context, clientId);

    const row = await this.database.transaction(context, (tx) =>
      this.announcements.create(tx, context, {
        clientId,
        title: input.title,
        body: input.body,
        startsAt,
        endsAt,
        createdBy: context.userId,
      }),
    );

    return toInternalView(row);
  }

  /**
   * Retract a banner — internal, `client_member.manage`. The client is resolved tenant-scoped first
   * (404 on a cross-tenant id), the capability is checked, then the delete runs scoped to
   * `(organization_id, client_id, id)`. Idempotent: a banner that is already gone is still a success.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    clientId: string,
    announcementId: string,
  ): Promise<void> {
    await this.resolveClient(context, clientId);
    this.authorizeManage(principal, context, clientId);

    await this.database.transaction(context, (tx) =>
      this.announcements.delete(tx, context, clientId, announcementId),
    );
  }

  /**
   * The banners active now for one client — the portal read, `client_projection.read`.
   *
   * The client organization is resolved tenant-scoped first (404 on a cross-tenant id), then
   * `authorize()` decides: a client principal reading another client's banners is a 404
   * (`client_organization_mismatch`), never an empty list, so this route cannot probe which client ids
   * exist. Only rows with `starts_at <= now` and `ends_at` null or future come back, and
   * {@link toClientView} carries no staff identity.
   */
  async listActiveForClient(
    context: TenantContext,
    principal: Principal,
    clientId: string,
  ): Promise<readonly ClientPortalAnnouncementView[]> {
    await this.resolveClient(context, clientId);
    this.authorizeRead(principal, context, clientId);

    const now = this.now();
    const rows = await this.database.read(context, (runner) =>
      this.announcements.listActiveForClient(runner, context, clientId, now),
    );
    return rows.map(toClientView);
  }

  /** Resolve the client organization tenant-scoped; a cross-tenant or unknown id is a 404. */
  private async resolveClient(context: TenantContext, clientId: string): Promise<void> {
    const row = await this.database.read(context, (runner) =>
      this.clients.findById(runner, context, clientId),
    );
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  }

  private authorizeManage(principal: Principal, context: TenantContext, clientId: string): void {
    this.enforce(
      principal,
      context,
      clientId,
      'client_member.manage',
      'portal_announcement.manage',
    );
  }

  private authorizeRead(principal: Principal, context: TenantContext, clientId: string): void {
    this.enforce(
      principal,
      context,
      clientId,
      'client_projection.read',
      'portal_announcement.read',
    );
  }

  /**
   * Check a capability against the client-facing resource. A role that lacks the capability is a
   * **403** (the route ceiling restated in the domain); every other denial — a client principal scoped
   * to a different client organization, an inactive membership — is a **404**, so a caller learns
   * nothing about which client organizations exist.
   */
  private enforce(
    principal: Principal,
    context: TenantContext,
    clientId: string,
    capability: 'client_member.manage' | 'client_projection.read',
    action: string,
  ): void {
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        // Null: a client organization is an org-level resource, not a project. Naming a project here
        // would let a project relation stand in for this client-facing capability.
        projectId: null,
        audience: 'client_visible',
        clientOrganizationId: clientId,
        lifecycle: 'active',
      },
    });
    if (verdict.allowed) return;

    const ceilingCodes: ReadonlySet<DenialCode> = new Set<DenialCode>([
      'capability_not_in_role_ceiling',
      'capability_is_internal_only',
    ]);
    if (ceilingCodes.has(verdict.code)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:${verdict.code}`,
      );
    }
    throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, `${action}:${verdict.code}`);
  }
}
