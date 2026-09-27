import { Controller, Get, HttpCode, Module, Param, Post } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { AdminSessionsRepository } from './admin-sessions.repository.js';
import { AdminSessionsService } from './admin-sessions.service.js';

/**
 * Admin active sessions + revocation (x223, Administration module 18) — the admin surface the
 * audit found absent over ID-001's session storage. Two routes behind `org.manage`, both about
 * the sessions of the people in the caller's organization; no `capabilities.ts` edit, no new
 * table (a revocation is a soft-close of an existing `sessions` row).
 *
 *   - **GET `…/admin/sessions`** — the live sessions of every active member, metadata only.
 *   - **POST `…/admin/sessions/:sessionId/revoke`** — soft-close one, idempotent.
 *
 * ## Resolve the session tenant-scoped BEFORE authorize (the Known trap)
 *
 * `@RequireCapability('org.manage')` is the coarse gate `CapabilityGuard` reads before the
 * handler runs. The revoke handler *also* resolves the addressed session first — its owner is
 * looked up on the identity path and checked against the caller's membership roster — and a
 * session that belongs to no member of this organization (a cross-tenant id, or an unknown one)
 * is a **404 with no write**, decided before the real `org.manage` authorize. A cross-tenant id
 * is therefore indistinguishable from a missing one and never leaks its existence through a 403.
 *
 * ## The projection carries no credential material
 *
 * Neither route ever returns a `refresh_token_hash` or any other token/secret — the list is
 * member, times and device label only (see {@link ActiveSessionView}). Revocation is a
 * soft-close (a `revoked_at` timestamp), never a hard delete, so the audit trail that refers to
 * a session id stays readable.
 */

/**
 * One row of the admin session list — the wire projection, paired Exact with `apps/web`'s
 * `ActiveSessionView` in the contracts gate. Metadata only: it names the member and the device,
 * the session's start and last-seen times, and nothing that could re-authenticate as anyone.
 */
export interface ActiveSessionView {
  readonly sessionId: string;
  readonly membershipId: string;
  readonly memberName: string;
  /** ISO-8601. When the session was established. */
  readonly createdAt: string;
  /** ISO-8601. Last activity — the last rotation, or the creation time if never rotated. */
  readonly lastSeenAt: string;
  /** The device label (user-agent) captured at sign-in, or `null` if none was sent. */
  readonly deviceLabel: string | null;
}

/** The org-wide resource the real `org.manage` decision authorizes against. */
function orgWideResource(context: TenantContext) {
  return {
    organizationId: context.organizationId,
    projectId: null,
    audience: 'internal' as const,
    lifecycle: 'active' as const,
  };
}

@Controller('v1/organizations/:orgSlug/admin/sessions')
export class AdminSessionsController {
  // The controller touches no database directly (ADR-0001 layer 4): it authorizes and delegates
  // every read and write to `AdminSessionsService`, which owns the two-runner bridge. Nest
  // resolves the service from the provider built in the module below; tests inject a fake.
  constructor(private readonly sessions: AdminSessionsService) {}

  /**
   * The live sessions of every active member of the organization (200). Read tenant-scoped
   * (the membership roster) then joined to the identity-path session rows for those members;
   * the projection is metadata only.
   */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly sessions: readonly ActiveSessionView[] }> {
    // The real org-wide `org.manage` decision (the decorator is the coarse HTTP gate).
    this.requireOrgManage(principal, context);
    const sessions = await this.sessions.listOrgSessions(context);
    return { sessions };
  }

  /**
   * Soft-close one session (200, idempotent). The session is resolved to a member of this
   * organization BEFORE the real authorize (unknown/cross-tenant → 404, no write, Known trap);
   * then `org.manage` is authorized for real (403); then the session is soft-closed. A
   * re-revoke of an already-closed session is a no-op that still answers 200.
   */
  @Post(':sessionId/revoke')
  @HttpCode(200)
  @RequireCapability('org.manage')
  async revoke(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId') sessionId: string,
  ): Promise<{ readonly revoked: true }> {
    // 1. Resolve the addressed session tenant-scoped, BEFORE authorize/write (Known trap).
    const resolved = await this.sessions.resolveMemberSession(context, sessionId);
    if (!resolved) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    // 2. The real org-wide `org.manage` decision.
    this.requireOrgManage(principal, context);

    // 3. Soft-close (idempotent, never a hard delete).
    await this.sessions.revokeSession(context, sessionId);
    return { revoked: true };
  }

  /** The real `org.manage` decision — org-wide. A denial is a 403 with the machine-readable code. */
  private requireOrgManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: orgWideResource(context),
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `admin_sessions.manage:${verdict.code}`,
      );
    }
  }
}

/**
 * x223's wiring — a self-contained module registered from `app.module.ts` (the shared append
 * point), file-disjoint from the identity module's own session routes. The service is built
 * over the `@Global` `TENANT_DATABASE` and a stateless repository.
 */
@Module({})
export class AdminSessionsModule {
  static register(): DynamicModule {
    return {
      module: AdminSessionsModule,
      providers: [
        {
          provide: AdminSessionsService,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new AdminSessionsService(database, new AdminSessionsRepository()),
        },
      ],
      controllers: [AdminSessionsController],
    };
  }
}
