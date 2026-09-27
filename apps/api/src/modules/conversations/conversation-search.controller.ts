import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  ConversationSearchService,
  MessageSearchMatchView,
} from './conversation-search.service.js';

/**
 * CH-10 "Search in conversation" — the HTTP surface (x253).
 *
 * One read route: `GET …/conversations/:conversationId/messages/search`, behind
 * `conversation.read`. It does no gate of its own beyond the coarse `@RequireCapability` —
 * {@link ConversationSearchService.searchMessages} resolves the conversation and applies the
 * authoritative `conversation.read` + channel-membership check, answering **404** for a
 * conversation in another tenant or one the caller is not in, before any message is read.
 *
 * The path is a distinct literal (`…/messages/search`) from every route in
 * `ConversationsController`: the only other `messages/…` GET is `messages/:messageId/revisions`,
 * two segments deep, so `search` never binds to `:messageId`. A separate controller keeps this
 * slice's files disjoint from that one.
 *
 * The token below is defined here rather than in the shared `tokens.ts` so that this slice adds
 * no line to a file another slice also appends to; `Symbol.for` keys a process-global registry,
 * so the module's provider and this injection resolve to the one symbol regardless.
 */

/** DI token for the search service. Local to this slice — see the file note above. */
export const CONVERSATION_SEARCH_SERVICE = Symbol.for('tmanage.ConversationSearchService');

/** The largest `page` a caller may ask for; a page beyond the matches is simply empty. */
const MAX_PAGE = 1_000_000;

@Controller('v1/organizations/:orgSlug')
export class ConversationSearchController {
  constructor(
    @Inject(CONVERSATION_SEARCH_SERVICE) private readonly search: ConversationSearchService,
  ) {}

  /**
   * Search a conversation's messages. A blank `q` returns an empty result rather than a 400.
   * `page` (1-based) and `limit` are validated to positive integers when present; the page size
   * is capped in the service.
   */
  @Get('conversations/:conversationId/messages/search')
  @RequireCapability('conversation.read')
  async run(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly results: readonly MessageSearchMatchView[] }> {
    const details: { field: string; message: string }[] = [];
    const parsedPage = parsePositiveInt(page, 'page', MAX_PAGE, details);
    const parsedLimit = parsePositiveInt(limit, 'limit', undefined, details);
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', details);
    }

    const results = await this.search.searchMessages(context, principal, conversationId, {
      q: typeof q === 'string' ? q : '',
      ...(parsedPage === undefined ? {} : { page: parsedPage }),
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
    });
    return { results };
  }
}

/** A query parameter that must be a positive integer when present, capped at `max` if given. */
function parsePositiveInt(
  raw: string | undefined,
  field: string,
  max: number | undefined,
  details: { field: string; message: string }[],
): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    details.push({ field, message: 'must be a positive integer' });
    return undefined;
  }
  return max === undefined ? parsed : Math.min(parsed, max);
}
