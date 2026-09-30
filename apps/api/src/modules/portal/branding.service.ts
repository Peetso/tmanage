import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PortalBrandingRow } from '../../common/database/schema.js';
import { ClientOrganizationsRepository } from '../clients/client-organizations.repository.js';
import { PortalBrandingRepository } from './branding.repository.js';
import {
  DEFAULT_PORTAL_BRANDING,
  type PortalBrandingClientView,
  type PortalBrandingView,
  type SavePortalBrandingCommand,
} from './branding.controller.js';

/**
 * The portal-branding service — SEC / Client portal branding (module 13, x323).
 *
 * Resolve the client-org scope tenant-scoped, authorize, then read or upsert — the portal-settings
 * (x238) service posture, keyed per client organization rather than per project. It holds the
 * {@link TenantDatabase} and the repositories, opens the read/transaction, and makes the authoritative
 * authorization decision. No driver handle lives here (the repository holds it).
 *
 * ## The Known-trap order (resolve scope BEFORE authorize)
 *
 * Every write names the client organization by id, so the scope is resolved **tenant-scoped first**
 * ({@link ClientOrganizationsRepository.findById}). An unknown or cross-tenant `clientOrganizationId`
 * returns `null` → 404, **before** any authorize or write — the "off-client 404" the brief names.
 * Then the capability check with the scope in hand: `client_member.manage` at an **internal** audience,
 * which `authorize()` denies any client principal, so the write is staff-only; a staff caller whose
 * role lacks the capability is a 403, and nothing is written.
 *
 * ## Defaults, not 404, for an unbranded client
 *
 * A client organization that has never been branded has no `portal_branding` row. The read fills
 * {@link DEFAULT_PORTAL_BRANDING} rather than 404-ing, so a resolvable scope always reads a branding
 * object and the editor shows the defaults to edit.
 *
 * ## The client projection is built field by field
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION §7` forbids building the client view by deleting fields from
 * the internal one; {@link toClientView} names only the presentation columns, so `updatedBy` — the one
 * internal field — is never carried across to a client.
 */
export class PortalBrandingService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly clientOrganizations: ClientOrganizationsRepository = new ClientOrganizationsRepository(),
    private readonly branding: PortalBrandingRepository = new PortalBrandingRepository(),
  ) {}

  /** Read one client's branding — the internal half. `client_member.manage`, staff only. */
  async getInternal(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
  ): Promise<PortalBrandingView> {
    await this.resolveManageable(context, principal, clientOrganizationId);
    const row = await this.database.read(context, (runner) =>
      this.branding.findForClientOrg(runner, context, clientOrganizationId),
    );
    return toInternalView(clientOrganizationId, row);
  }

  /**
   * Save (create or replace) one client's branding. `client_member.manage`, staff only. The caller has
   * already validated the accent shape and the string bounds; nothing is written on an invalid input.
   */
  async save(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
    input: SavePortalBrandingCommand,
  ): Promise<PortalBrandingView> {
    await this.resolveManageable(context, principal, clientOrganizationId);

    const row = await this.database.transaction(context, (tx) =>
      this.branding.upsert(tx, context, clientOrganizationId, {
        accentColor: input.accentColor,
        welcomeHeading: input.welcomeHeading,
        welcomeText: input.welcomeText,
        updatedBy: context.userId,
      }),
    );

    return toInternalView(clientOrganizationId, row);
  }

  /**
   * Read one client's branding this client may see — the client half.
   *
   * A client reads only their **own** scope: a `clientOrganizationId` other than the principal's is a
   * 404 before anything is read (a client probing scope ids must not learn which are real). Then
   * `authorize()` at audience `client_visible` confirms the client projection is reachable. The
   * projection carries the presentation fields only.
   */
  async getForClient(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
  ): Promise<PortalBrandingClientView> {
    if (!this.mayRead(principal, clientOrganizationId)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    const row = await this.database.read(context, (runner) =>
      this.branding.findForClientOrg(runner, context, clientOrganizationId),
    );
    return toClientView(row);
  }

  /**
   * Resolve the client-org scope tenant-scoped, then check the caller may manage client members.
   * Throws 404 for an unknown or cross-tenant scope (before the capability is weighed), and 403 for a
   * caller whose role lacks `client_member.manage` or is a client principal (denied the internal
   * audience). Nothing is written on either refusal.
   */
  private async resolveManageable(
    context: TenantContext,
    principal: Principal,
    clientOrganizationId: string,
  ): Promise<void> {
    const clientOrganization = await this.database.read(context, (runner) =>
      this.clientOrganizations.findById(runner, context, clientOrganizationId),
    );
    if (!clientOrganization) {
      // 404, not 403 — a cross-tenant or unknown scope must not be distinguishable from a real one.
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const verdict = authorize({
      principal,
      capability: 'client_member.manage',
      resource: {
        organizationId: context.organizationId,
        // Org-level resource: branding belongs to a client organization, not a project.
        projectId: null,
        // Internal audience — a client principal is denied here, so the write is staff-only.
        audience: 'internal',
        clientOrganizationId,
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  /** May this principal read the client projection of this client-org scope? */
  private mayRead(principal: Principal, clientOrganizationId: string): boolean {
    return authorize({
      principal,
      capability: 'client_projection.read',
      resource: {
        organizationId: principal.organizationId,
        projectId: null,
        audience: 'client_visible',
        clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
  }
}

/**
 * The internal record — built field by field. Fills {@link DEFAULT_PORTAL_BRANDING} when the client
 * has never been branded (`row` is null), so `updatedBy`/`updatedAt` are null and the presentation
 * fields are the defaults.
 */
function toInternalView(
  clientOrganizationId: string,
  row: PortalBrandingRow | null,
): PortalBrandingView {
  if (!row) {
    return {
      clientOrganizationId,
      accentColor: DEFAULT_PORTAL_BRANDING.accentColor,
      welcomeHeading: DEFAULT_PORTAL_BRANDING.welcomeHeading,
      welcomeText: DEFAULT_PORTAL_BRANDING.welcomeText,
      updatedBy: null,
      updatedAt: null,
    };
  }
  return {
    clientOrganizationId: row.clientOrgScopeId,
    accentColor: row.accentColor,
    welcomeHeading: row.welcomeHeading,
    welcomeText: row.welcomeText,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The client projection — built field by field, no `updatedBy`, no `updatedAt`, no scope id. This is
 * the audience boundary of the slice. Fills the defaults when the client has never been branded, so a
 * client always reads a branding object.
 */
function toClientView(row: PortalBrandingRow | null): PortalBrandingClientView {
  if (!row) {
    return {
      accentColor: DEFAULT_PORTAL_BRANDING.accentColor,
      welcomeHeading: DEFAULT_PORTAL_BRANDING.welcomeHeading,
      welcomeText: DEFAULT_PORTAL_BRANDING.welcomeText,
    };
  }
  return {
    accentColor: row.accentColor,
    welcomeHeading: row.welcomeHeading,
    welcomeText: row.welcomeText,
  };
}
