import { Controller, Get, Header, Inject, Optional } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { EinvoiceChainCheckRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import { EinvoiceChainRepository } from './einvoice-chain.repository.js';

export type EinvoiceChainView =
  | {
      readonly status: 'ok' | 'broken' | 'empty';
      readonly checkedAt: string;
      readonly headIcv: number | null;
      readonly documents: number;
      readonly breakIcv: number | null;
      readonly breakReason: string | null;
    }
  | { readonly status: 'never_checked' };

const forbidden = (code: string): ApiError =>
  new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, code);

const STATUSES = new Set(['ok', 'broken', 'empty']);

export function toChainView(row: EinvoiceChainCheckRow | null): EinvoiceChainView {
  if (row === null || !STATUSES.has(row.status)) return { status: 'never_checked' };
  return {
    status: row.status as 'ok' | 'broken' | 'empty',
    checkedAt: row.checkedAt.toISOString(),
    headIcv: row.headIcv ?? null,
    documents: row.documents,
    breakIcv: row.breakIcv ?? null,
    breakReason: row.breakReason ?? null,
  };
}

/**
 * 52-12 (R22-b) — `GET /v1/organizations/:orgSlug/finance/einvoicing/chain`: the newest verdict of
 * the worker's nightly ICV/PIH chain reconciler (`einvoice_chain_checks`, 0314), or
 * `never_checked`. `finance.view` (the coarse guard) and the org-scoped `authorize()`; a client
 * principal is refused 403 (org-internal). Read-only, `private, no-store`. Holds ids, counts and
 * closed tokens only — never a hash, never an amount.
 */
@Controller('v1/organizations/:orgSlug/finance/einvoicing')
export class EinvoiceChainController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(EinvoiceChainRepository)
    private readonly repository: EinvoiceChainRepository = new EinvoiceChainRepository(),
  ) {}

  @Get('chain')
  @RequireCapability('finance.view')
  @Header('Cache-Control', 'private, no-store')
  async chain(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<EinvoiceChainView> {
    if (principal.kind !== 'internal') throw forbidden('einvoice_chain.internal_only');
    const verdict = authorize({
      principal,
      capability: 'finance.view',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) throw forbidden('einvoice_chain.view');
    const row = await this.database.read(context, (runner) =>
      this.repository.latest(runner, context.organizationId),
    );
    return toChainView(row);
  }
}
