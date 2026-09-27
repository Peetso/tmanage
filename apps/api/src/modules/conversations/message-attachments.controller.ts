import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MessageAttachmentsService } from './message-attachments.service.js';
import type { MessageAttachmentView } from './message-attachments.service.js';

/**
 * x275 — CH-06's composer attachments. A message author links an already-uploaded file to their
 * message and detaches it; any reader of the conversation lists a message's attachments.
 *
 * Attach and detach are gated on `conversation.write`, list on `conversation.read` —
 * {@link MessageAttachmentsService} then applies the same relation gate reading/writing a message
 * applies (conversation membership, or organization-wide scope), refusing a caller with no relation
 * to the conversation with 404 before any write, and refusing a caller who is not the message's
 * author with 403. No new capability: chat is internal-only (`12-PERMISSION-MATRIX` §2), and a
 * client role holds no conversation capability, so `CapabilityGuard` refuses one on the ceiling
 * before this runs.
 *
 * There is no upload here — the file store is reused read-only. `POST` answers 201 for a new link
 * and 200 for one that already existed (idempotent), so a composer that retries never double-links.
 */
interface AttachBody {
  readonly fileId?: unknown;
}

/** `@Res({ passthrough: true })`, as `ConversationsController` documents — one route, two statuses. */
interface ReplyLike {
  status(code: number): unknown;
}

@Controller('v1/organizations/:orgSlug')
export class MessageAttachmentsController {
  constructor(
    @Inject(MessageAttachmentsService) private readonly attachments: MessageAttachmentsService,
  ) {}

  /** Attach an already-uploaded file to a message. 201 for a new link, 200 if it already existed. */
  @Post('conversations/:conversationId/messages/:messageId/attachments')
  @RequireCapability('conversation.write')
  async attach(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() body: AttachBody,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<MessageAttachmentView> {
    const fileId = typeof body?.fileId === 'string' && body.fileId !== '' ? body.fileId : undefined;
    if (!fileId) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'fileId', message: 'must be a non-empty string' },
      ]);
    }

    const result = await this.attachments.attach(
      context,
      principal,
      conversationId,
      messageId,
      fileId,
    );
    reply.status(result.created ? 201 : 200);
    return result.attachment;
  }

  /** Detach a file from a message. Idempotent — 204 whether or not there was a link to remove. */
  @Delete('conversations/:conversationId/messages/:messageId/attachments/:fileId')
  @RequireCapability('conversation.write')
  @HttpCode(204)
  async detach(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Param('fileId') fileId: string,
  ): Promise<void> {
    await this.attachments.detach(context, principal, conversationId, messageId, fileId);
  }

  /** A message's attachments, oldest first. */
  @Get('conversations/:conversationId/messages/:messageId/attachments')
  @RequireCapability('conversation.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<{ readonly attachments: readonly MessageAttachmentView[] }> {
    return {
      attachments: await this.attachments.list(context, principal, conversationId, messageId),
    };
  }
}

/**
 * x275's wiring — its own module, registered in `app.module.ts` beside `ConversationsModule`, so the
 * sibling chat slices stay file-disjoint (each registers its own module rather than all editing
 * `conversations.module.ts`). The stateless {@link MessageAttachmentsService} is provided by a
 * factory over the global tenant database; it constructs its own (equally stateless) repositories,
 * the posture `MessageBookmarksModule` records.
 */
@Module({})
export class MessageAttachmentsModule {
  static register(): DynamicModule {
    return {
      module: MessageAttachmentsModule,
      providers: [
        {
          provide: MessageAttachmentsService,
          useFactory: (database: TenantDatabase) => new MessageAttachmentsService(database),
          inject: [TENANT_DATABASE],
        },
      ],
      controllers: [MessageAttachmentsController],
    };
  }
}
