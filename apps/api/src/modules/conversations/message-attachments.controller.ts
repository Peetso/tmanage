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
  Query,
  Res,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { MALWARE_SCANNER, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MessageAttachmentsService } from './message-attachments.service.js';
import type {
  MessageAttachmentsOfMessage,
  MessageAttachmentView,
} from './message-attachments.service.js';
import type { ScannerPresence } from '../tenancy/download-scan-policy.js';

/** L2: how many message ids one batched read may name — one channel page (`MAX_MESSAGE_PAGE`). */
export const MAX_ATTACHMENT_BATCH_MESSAGE_IDS = 200;

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

  /**
   * L2 — `GET …/conversations/:conversationId/attachments?messageIds=a,b,c`: the attachments of
   * many messages of one channel in one request (C5's reactions shape), so a channel page does not
   * ask once per message. Capped at one page of messages.
   */
  @Get('conversations/:conversationId/attachments')
  @RequireCapability('conversation.read')
  async listMany(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Query('messageIds') messageIds?: unknown,
  ): Promise<{ readonly messages: readonly MessageAttachmentsOfMessage[] }> {
    const ids = (typeof messageIds === 'string' ? messageIds : '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    if (
      ids.length === 0 ||
      ids.length > MAX_ATTACHMENT_BATCH_MESSAGE_IDS ||
      ids.some((id) => id.length > 36)
    ) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', [
        {
          field: 'messageIds',
          message: `must list 1 to ${MAX_ATTACHMENT_BATCH_MESSAGE_IDS} message ids, comma separated`,
        },
      ]);
    }
    return {
      messages: await this.attachments.listMany(context, principal, conversationId, ids),
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
          // L2: the scanner (global `ScannerModule`) tells the scan status the download door's
          // policy; optional, so a context without it reads as `allow_labeled`.
          useFactory: (database: TenantDatabase, scanner?: ScannerPresence) =>
            new MessageAttachmentsService(database, undefined, undefined, undefined, scanner),
          inject: [TENANT_DATABASE, { token: MALWARE_SCANNER, optional: true }],
        },
      ],
      controllers: [MessageAttachmentsController],
    };
  }
}
