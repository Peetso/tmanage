import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PortalSettingsRow } from '../../common/database/schema.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { PortalSettingsRepository } from './portal-settings.repository.js';
import {
  DEFAULT_PORTAL_SETTINGS,
  type PortalSettingsClientView,
  type PortalSettingsView,
  type SavePortalSettingsCommand,
} from './portal-settings.controller.js';

/**
 * The portal-settings service — SEC / Client portal (module 13, x238).
 *
 * Resolve the project tenant-scoped, authorize, then read or upsert. It is a thin business layer over
 * the read/upsert repository, following the portal-risks (x140) service posture: it holds the
 * {@link TenantDatabase} and the repositories, opens the read/transaction, and makes the authoritative
 * authorization decision. No driver handle lives here (the repository holds it), so this file is free
 * of the `no-restricted-imports` boundary that reserves `drizzle-orm` for repository/database modules.
 *
 * ## The Known-trap order
 *
 * Every method names the project by id, so the project is resolved **tenant-scoped first**
 * ({@link ProjectsRepository.findById}). An unknown or cross-tenant `projectId` returns `null` → 404,
 * **before** any authorize or write — without it an org-wide caller would drive the id into the
 * composite foreign key, a 500 rather than a not-found. Then the relation check with the project in
 * hand: an internal caller who cannot manage the project gets 404, never 403 (403 would confirm it
 * exists). The tenant and the author come from the context, never the body.
 *
 * ## Defaults, not 404, for an unconfigured project
 *
 * A project that has never been configured has no `portal_settings` row. The read fills
 * {@link DEFAULT_PORTAL_SETTINGS} rather than 404-ing, so a resolvable project always reads a settings
 * object and the settings screen shows the defaults to edit — the `notification_preferences` posture.
 *
 * ## The client projection is built field by field
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION §7` forbids building the client view by deleting fields from
 * the internal one; {@link toClientView} names only the presentation columns, so `updatedBy` — the one
 * internal field — is never carried across to a client. A column added to `portal_settings` tomorrow
 * is invisible to a client until somebody decides it should not be.
 */
export class PortalSettingsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly settings: PortalSettingsRepository = new PortalSettingsRepository(),
  ) {}

  /** Read one project's portal settings — the internal half. `project.manage`, internal only. */
  async getInternal(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<PortalSettingsView> {
    await this.resolveManageable(context, principal, projectId);
    const row = await this.database.read(context, (runner) =>
      this.settings.findForProject(runner, context, projectId),
    );
    return toInternalView(projectId, row);
  }

  /**
   * Save (create or replace) one project's portal settings. `project.manage`, internal only. The
   * caller has already validated the accent palette and message bound; nothing is written on an
   * invalid input.
   */
  async save(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    input: SavePortalSettingsCommand,
  ): Promise<PortalSettingsView> {
    await this.resolveManageable(context, principal, projectId);

    const row = await this.database.transaction(context, (tx) =>
      this.settings.upsert(tx, context, projectId, {
        welcomeMessage: input.welcomeMessage,
        accentColor: input.accentColor,
        showTeam: input.showTeam,
        showTimeline: input.showTimeline,
        updatedBy: context.userId,
      }),
    );

    return toInternalView(projectId, row);
  }

  /**
   * Read one project's portal settings this client may see — the client half.
   *
   * {@link mayRead} runs `authorize()` for a client — the project must be in `principal.projectIds`,
   * which comes from `project_clients` and nothing else — and an unknown, cross-tenant or
   * sibling-client `projectId` fails it. The refusal is **404, not 403**: a client probing project ids
   * must not learn which of them are real. The projection carries the presentation fields only.
   */
  async getForClient(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<PortalSettingsClientView> {
    if (!this.mayRead(principal, projectId)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    const row = await this.database.read(context, (runner) =>
      this.settings.findForProject(runner, context, projectId),
    );
    return toClientView(row);
  }

  /**
   * Resolve the project tenant-scoped, then check the caller may manage it. Throws 404 on either miss,
   * so a caller can tell neither which projects exist nor which they are barred from.
   */
  private async resolveManageable(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    const permitted = authorize({
      principal,
      capability: 'project.manage',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;

    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
  }

  /** May this principal read the client projection of this project? `authorize()` rules 7-10. */
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

/**
 * The internal record — built field by field. Fills {@link DEFAULT_PORTAL_SETTINGS} when the project
 * has never been configured (`row` is null), so `updatedBy`/`updatedAt` are null and the presentation
 * fields are the defaults.
 */
function toInternalView(projectId: string, row: PortalSettingsRow | null): PortalSettingsView {
  if (!row) {
    return {
      projectId,
      welcomeMessage: DEFAULT_PORTAL_SETTINGS.welcomeMessage,
      accentColor: DEFAULT_PORTAL_SETTINGS.accentColor,
      showTeam: DEFAULT_PORTAL_SETTINGS.showTeam,
      showTimeline: DEFAULT_PORTAL_SETTINGS.showTimeline,
      updatedBy: null,
      updatedAt: null,
    };
  }
  return {
    projectId: row.projectId,
    welcomeMessage: row.welcomeMessage,
    accentColor: row.accentColor,
    showTeam: row.showTeam,
    showTimeline: row.showTimeline,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The client projection — built field by field, no `updatedBy`, no `updatedAt`, no `projectId`. This
 * is the audience boundary of the slice. Fills the defaults when the project has never been configured,
 * so a client always reads a branding object.
 */
function toClientView(row: PortalSettingsRow | null): PortalSettingsClientView {
  if (!row) {
    return {
      welcomeMessage: DEFAULT_PORTAL_SETTINGS.welcomeMessage,
      accentColor: DEFAULT_PORTAL_SETTINGS.accentColor,
      showTeam: DEFAULT_PORTAL_SETTINGS.showTeam,
      showTimeline: DEFAULT_PORTAL_SETTINGS.showTimeline,
    };
  }
  return {
    welcomeMessage: row.welcomeMessage,
    accentColor: row.accentColor,
    showTeam: row.showTeam,
    showTimeline: row.showTimeline,
  };
}
