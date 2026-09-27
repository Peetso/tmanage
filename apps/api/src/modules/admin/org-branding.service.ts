import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OrgBrandingRow } from '../../common/database/schema.js';
import { OrgBrandingRepository } from './org-branding.repository.js';
import {
  DEFAULT_ORG_BRANDING,
  type OrgBrandingView,
  type SaveOrgBrandingCommand,
} from './org-branding.controller.js';

/**
 * The org-branding service — ADM / org identity (Administration, module 18, x327).
 *
 * A thin business layer over the read/upsert repository, following the export-requests (x224) and
 * portal-settings (x238) posture: it holds the {@link TenantDatabase} and the repository, opens the
 * read/transaction, and makes the authoritative authorization decision for the write. No driver handle
 * lives here (the repository holds it), so this file is free of the `no-restricted-imports` boundary
 * that reserves `drizzle-orm` for repository/database modules.
 *
 * ## Read — any member, the guard is the gate
 *
 * {@link get} resolves the acting studio's branding for the shell to render. The route sits behind
 * `work.read` (every authenticated member holds it; a client principal does not), so the coarse guard
 * is the authorization: the read is tenant-scoped and needs no further object-level decision. A studio
 * that has never configured its branding reads {@link DEFAULT_ORG_BRANDING} rather than 404-ing, so a
 * resolvable tenant always reads a branding object.
 *
 * ## Write — the Known-trap order
 *
 * {@link set} resolves the organization tenant-scoped **first**; a context whose organization does not
 * resolve is a 404, **before** any authorize or write. Then the real org-wide `authorize` for
 * `org.manage` (the decorator is the coarse HTTP gate; this is the tenant-checked decision the test
 * exercises): a caller without it is a 403 with no upsert. The caller has already validated the body,
 * so nothing is written on an invalid input either. The tenant and the author come from the context,
 * never the body.
 */
export class OrgBrandingService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly branding: OrgBrandingRepository = new OrgBrandingRepository(),
  ) {}

  /** Read the acting studio's branding — any member (`work.read`). Fills defaults when unconfigured. */
  async get(context: TenantContext): Promise<OrgBrandingView> {
    const row = await this.database.read(context, (runner) =>
      this.branding.findForOrganization(runner, context),
    );
    return toView(row);
  }

  /**
   * Save (create or replace) the acting studio's branding — `org.manage`, org-wide. The organization is
   * resolved tenant-scoped before authorize/write (a cross-tenant context is a 404, no upsert); a
   * caller without `org.manage` is a 403, no upsert.
   */
  async set(
    context: TenantContext,
    principal: Principal,
    input: SaveOrgBrandingCommand,
  ): Promise<OrgBrandingView> {
    const row = await this.database.transaction(context, async (tx) => {
      const org = await this.branding.resolveOrganization(tx, context);
      if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      this.requireOrgManage(principal, context);

      return this.branding.upsert(tx, context, {
        productName: input.productName,
        accentColor: input.accentColor,
        logoText: input.logoText,
        updatedBy: context.userId,
      });
    });

    return toView(row);
  }

  /**
   * The real `org.manage` decision — org-wide, so `projectId: null` and an internal audience. An
   * internal role holding `org.manage` passes; anyone else is refused, and a cross-tenant principal by
   * the tenant check inside `authorize`. A denial is a 403 with the machine-readable code.
   */
  private requireOrgManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `org_branding.manage:${verdict.code}`,
      );
    }
  }
}

/**
 * Project a branding row to the wire shape, filling {@link DEFAULT_ORG_BRANDING} when the studio has
 * never configured its branding (`row` is null), so `updatedBy`/`updatedAt` are null and the
 * presentation fields are the defaults.
 */
function toView(row: OrgBrandingRow | null): OrgBrandingView {
  if (!row) {
    return {
      productName: DEFAULT_ORG_BRANDING.productName,
      accentColor: DEFAULT_ORG_BRANDING.accentColor,
      logoText: DEFAULT_ORG_BRANDING.logoText,
      updatedBy: null,
      updatedAt: null,
    };
  }
  return {
    productName: row.productName,
    accentColor: row.accentColor,
    logoText: row.logoText,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}
