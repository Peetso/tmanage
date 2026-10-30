import type { PublicLinkRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type {
  PublicLinkTargetAdapter,
  ResolvedTarget,
} from '../public-links/public-link-targets.js';
import { DECISION_STATUS, publicProjection } from './quote-content.js';
import type { QuotesRepository } from './quotes.repository.js';

export const QUOTE_TARGET_TYPE = 'quote';

export interface QuoteTargetDeps {
  readonly repository: Pick<QuotesRepository, 'find' | 'lines' | 'decide'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly now?: () => Date;
}

/**
 * 52-08 — the 56-07 `quote` target adapter. A link reaches one SENT quote of the link's own
 * organization (the context is the link's service context): a draft, a decided quote or one past
 * its validity resolves to `null`, which the link system shows as expired. The link binds the
 * quote's `content_hash`; the projection is the lines and totals only. `accept` always needs the
 * e-mail code; accepting or declining moves the quote's status in the decision's transaction.
 */
export function quoteTarget(deps: QuoteTargetDeps): PublicLinkTargetAdapter {
  const now = deps.now ?? (() => new Date());
  return {
    targetType: QUOTE_TARGET_TYPE,
    kinds: ['quote'],
    manageCapability: 'project.manage',
    decisions: ['accept', 'decline'],
    decisionsRequiringCode: ['accept'],
    async resolve(
      runner: TenantQueryRunner,
      context: TenantContext,
      targetId: string,
    ): Promise<ResolvedTarget | null> {
      const quote = await deps.repository.find(runner, context, targetId);
      if (quote === null || quote.status !== 'sent' || quote.contentHash === null) return null;
      if (quote.validUntil <= now()) return null;
      const lines = await deps.repository.lines(runner, context, quote.id);
      return {
        projectId: null,
        versionHash: quote.contentHash,
        projection: publicProjection(quote, lines),
      };
    },
    async onDecision(
      runner: TenantQueryRunner,
      context: TenantContext,
      link: PublicLinkRow,
      decision: string,
    ): Promise<void> {
      const status = DECISION_STATUS[decision];
      if (status === undefined || link.versionHash === null) {
        throw new ApiError(409, 'conflict', 'This quote can no longer be decided.');
      }
      const moved = await deps.repository.decide(
        runner,
        context,
        link.targetId,
        link.versionHash,
        status,
        now(),
      );
      if (!moved) throw new ApiError(409, 'conflict', 'This quote can no longer be decided.');
      await deps.audit.record(runner, context, {
        action: status === 'accepted' ? 'quote.accepted' : 'quote.declined',
        result: 'allowed',
        objectId: link.targetId,
        actorUserId: null,
        metadata: { link_id: link.id },
      });
    },
  };
}
