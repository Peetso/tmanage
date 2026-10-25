import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { OUTBOX_EVENTS_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { DirectConversationsRepository } from './direct-conversations.repository.js';
import { DirectConversationsService } from './direct-conversations.service.js';
import type {
  DirectConversationView,
  DirectMessageView,
  DirectReadStateView,
} from './direct-conversations.service.js';

/**
 * BK3 (COL-03) — direct messages over HTTP.
 *
 * The routes declare `client_projection.read`, the one capability every internal and client role
 * holds (the precedent is `feedback.controller.ts`'s client write): the guard only proves an
 * active member of this tenant. The real gate is {@link DirectConversationsService}'s relation
 * rule plus, for an internal caller, `conversation.read` / `conversation.write`.
 */

/** `messages.body`'s limit, restated: well under the 65535-byte `TEXT`. */
const MAX_BODY_LENGTH = 16_000;

interface ReplyLike {
  status(code: number): unknown;
}

export const DIRECT_CONVERSATIONS_SERVICE = Symbol('DIRECT_CONVERSATIONS_SERVICE');

@Controller('v1/organizations/:orgSlug/direct-conversations')
export class DirectConversationsController {
  constructor(
    @Inject(DIRECT_CONVERSATIONS_SERVICE) private readonly direct: DirectConversationsService,
  ) {}

  @Get()
  @RequireCapability('client_projection.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{
    readonly conversations: readonly DirectConversationView[];
    /** C5: the caller's own user id, so "New message" can leave the caller out of its lists. */
    readonly viewerUserId: string;
  }> {
    return {
      conversations: await this.direct.list(context, principal),
      viewerUserId: context.userId,
    };
  }

  /** Create-or-get: 201 when opened here, 200 when it already existed. */
  @Post()
  @RequireCapability('client_projection.read')
  async open(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: { readonly userId?: unknown },
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<DirectConversationView> {
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    if (userId === '' || userId.length > 36) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'userId', message: 'must be a member id' },
      ]);
    }
    const result = await this.direct.open(context, principal, userId);
    reply.status(result.created ? 201 : 200);
    return result.conversation;
  }

  @Get(':directConversationId/messages')
  @RequireCapability('client_projection.read')
  async listMessages(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('directConversationId') directConversationId: string,
    @Query('afterSequenceNo') afterSequenceNo?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly messages: readonly DirectMessageView[] }> {
    const details: { field: string; message: string }[] = [];
    const after = afterSequenceNo === undefined ? undefined : Number(afterSequenceNo);
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) {
      details.push({ field: 'afterSequenceNo', message: 'must be a non-negative integer' });
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
      details.push({ field: 'limit', message: 'must be a positive integer' });
    }
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', details);
    }
    return {
      messages: await this.direct.listMessages(context, principal, directConversationId, {
        ...(after === undefined ? {} : { afterSequenceNo: after }),
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      }),
    };
  }

  /** Post: 201 for a new message, 200 for a deduplicated retry. */
  @Post(':directConversationId/messages')
  @RequireCapability('client_projection.read')
  async post(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('directConversationId') directConversationId: string,
    @Body() body: { readonly body?: unknown; readonly clientGeneratedId?: unknown },
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<DirectMessageView> {
    const details: { field: string; message: string }[] = [];
    const text = typeof body?.body === 'string' ? body.body.trim() : '';
    if (text === '') details.push({ field: 'body', message: 'must be a non-empty string' });
    if (text.length > MAX_BODY_LENGTH) {
      details.push({ field: 'body', message: `must be ${MAX_BODY_LENGTH} characters or fewer` });
    }
    const raw = body?.clientGeneratedId;
    if (raw !== undefined && (typeof raw !== 'string' || raw === '' || raw.length > 36)) {
      details.push({
        field: 'clientGeneratedId',
        message: 'must be an id of 36 characters or fewer',
      });
    }
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    const result = await this.direct.post(context, principal, directConversationId, {
      body: text,
      ...(typeof raw === 'string' ? { clientGeneratedId: raw } : {}),
    });
    reply.status(result.created ? 201 : 200);
    return result.message;
  }

  /**
   * BK3-left (0216): mark-read. Body `{ lastReadSequenceNo? }` — up to that message, or to the
   * latest when omitted. Only ever moves forward; answers the caller's new position.
   */
  @Put(':directConversationId/read-state')
  @RequireCapability('client_projection.read')
  @HttpCode(200)
  async markRead(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('directConversationId') directConversationId: string,
    @Body() body: { readonly lastReadSequenceNo?: unknown } | undefined,
  ): Promise<DirectReadStateView> {
    const raw = body?.lastReadSequenceNo;
    if (raw !== undefined && (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'lastReadSequenceNo', message: 'must be a non-negative integer' },
      ]);
    }
    return this.direct.markRead(
      context,
      principal,
      directConversationId,
      typeof raw === 'number' ? raw : undefined,
    );
  }
}

/** Its own module, registered in `app.module.ts`, so the chat slices stay file-disjoint. */
@Module({})
export class DirectConversationsModule {
  static register(): DynamicModule {
    return {
      module: DirectConversationsModule,
      providers: [
        {
          provide: DIRECT_CONVERSATIONS_SERVICE,
          inject: [TENANT_DATABASE, OUTBOX_EVENTS_REPOSITORY],
          useFactory: (database: TenantDatabase, outbox: OutboxEventsRepository) =>
            new DirectConversationsService(database, new DirectConversationsRepository(), outbox),
        },
      ],
      controllers: [DirectConversationsController],
    };
  }
}
