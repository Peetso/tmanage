import { Controller, Get, Inject, Module, Param, Query } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ConversationsRepository } from './conversations.repository.js';
import { ConversationsService } from './conversations.service.js';
import { MentionCandidatesRepository } from './mention-candidates.repository.js';

/**
 * BK3 (COL-02) — the @ picker's search: `GET .../conversations/:id/mention-candidates?q=&limit=`.
 *
 * The channel is resolved through `ConversationsService.get` first, so a channel the caller
 * cannot read is the same 404 every chat route gives, and nothing is searched. A candidate's
 * `mention` is the token to insert (`@<userId>`) — the form `extractMentionedUserIds` reads when
 * the message is posted, which is what turns it into a `message.mentioned.v1` notification.
 */

export interface MentionCandidateView {
  readonly userId: string;
  readonly displayName: string;
  readonly mention: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MAX_QUERY = 100;

export class MentionCandidatesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly conversations: Pick<ConversationsService, 'get'>,
    private readonly repository: MentionCandidatesRepository,
  ) {}

  async search(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    prefix: string,
    limit: number = DEFAULT_LIMIT,
  ): Promise<readonly MentionCandidateView[]> {
    await this.conversations.get(context, principal, conversationId);
    const rows = await this.database.read(context, (runner) =>
      this.repository.search(runner, context, conversationId, prefix, limit),
    );
    const seen = new Set<string>([context.userId]); // mentioning yourself notifies nobody
    const out: MentionCandidateView[] = [];
    for (const row of [...rows].sort((a, b) => a.displayName.localeCompare(b.displayName))) {
      if (seen.has(row.userId)) continue;
      seen.add(row.userId);
      out.push({ userId: row.userId, displayName: row.displayName, mention: `@${row.userId}` });
    }
    return out.slice(0, limit);
  }
}

export const MENTION_CANDIDATES_SERVICE = Symbol('MENTION_CANDIDATES_SERVICE');

@Controller('v1/organizations/:orgSlug/conversations')
export class MentionCandidatesController {
  constructor(
    @Inject(MENTION_CANDIDATES_SERVICE) private readonly candidates: MentionCandidatesService,
  ) {}

  @Get(':conversationId/mention-candidates')
  @RequireCapability('conversation.read')
  async search(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly candidates: readonly MentionCandidateView[] }> {
    const prefix = (q ?? '').trim().replace(/^@/, '');
    const parsedLimit = limit === undefined ? DEFAULT_LIMIT : Number(limit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_LIMIT) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', [
        { field: 'limit', message: `must be an integer from 1 to ${MAX_LIMIT}` },
      ]);
    }
    if (prefix.length > MAX_QUERY) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', [
        { field: 'q', message: `must be ${MAX_QUERY} characters or fewer` },
      ]);
    }
    return {
      candidates: await this.candidates.search(
        context,
        principal,
        conversationId,
        prefix,
        parsedLimit,
      ),
    };
  }
}

/** Its own module, registered in `app.module.ts` beside the other chat slices. */
@Module({})
export class MentionCandidatesModule {
  static register(): DynamicModule {
    return {
      module: MentionCandidatesModule,
      providers: [
        {
          provide: MENTION_CANDIDATES_SERVICE,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new MentionCandidatesService(
              database,
              new ConversationsService(database, new ConversationsRepository()),
              new MentionCandidatesRepository(),
            ),
        },
      ],
      controllers: [MentionCandidatesController],
    };
  }
}
