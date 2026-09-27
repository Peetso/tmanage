import { Controller, Delete, Get, HttpCode, Inject, Module, Param, Put } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MessageBookmarksService } from './message-bookmarks.service.js';
import type { SavedMessageView } from './message-bookmarks.service.js';

/**
 * x248 — CH-07's "Save" message action. A member privately saves/unsaves a message and lists
 * their saved messages across conversations.
 *
 * Every route is gated on `conversation.read`: saving a message is the right to read it, so the
 * ceiling is the read ceiling and {@link MessageBookmarksService} then applies the same relation
 * gate (conversation membership, or organization-wide scope) that reading a message applies —
 * refusing a caller with no relation to the conversation with 404 before any write. No new
 * capability: chat is internal-only (`12-PERMISSION-MATRIX` §2), and a client role holds no
 * conversation capability, so `CapabilityGuard` refuses one on the ceiling before this runs.
 *
 * `PUT`/`DELETE` are idempotent by design — a save is 200 whether or not it already existed, an
 * unsave is 204 whether or not there was anything to remove — so the toggle a screen draws never
 * has to distinguish "already saved" from "just saved".
 */
@Controller('v1/organizations/:orgSlug')
export class MessageBookmarksController {
  constructor(
    @Inject(MessageBookmarksService) private readonly bookmarks: MessageBookmarksService,
  ) {}

  /** Save a message. Idempotent — 200 whether or not it was already saved. */
  @Put('conversations/:conversationId/messages/:messageId/bookmark')
  @RequireCapability('conversation.read')
  @HttpCode(200)
  async save(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<{ readonly saved: true }> {
    await this.bookmarks.bookmark(context, principal, conversationId, messageId);
    return { saved: true };
  }

  /** Unsave a message. Idempotent — 204 whether or not there was a save to remove. */
  @Delete('conversations/:conversationId/messages/:messageId/bookmark')
  @RequireCapability('conversation.read')
  @HttpCode(204)
  async unsave(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<void> {
    await this.bookmarks.unbookmark(context, principal, conversationId, messageId);
  }

  /** The caller's saved messages, newest first, across the conversations they still read. */
  @Get('message-bookmarks')
  @RequireCapability('conversation.read')
  async listMine(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly messages: readonly SavedMessageView[] }> {
    return { messages: await this.bookmarks.listMine(context, principal) };
  }
}

/**
 * x248's wiring — its own module, registered in `app.module.ts` beside `ConversationsModule`, so
 * the sibling chat slices stay file-disjoint (each registers its own module rather than all
 * editing `conversations.module.ts`). The stateless {@link MessageBookmarksService} is provided by
 * a factory over the global tenant database; it constructs its own (equally stateless)
 * repositories, the posture `CalendarGridModule` records.
 */
@Module({})
export class MessageBookmarksModule {
  static register(): DynamicModule {
    return {
      module: MessageBookmarksModule,
      providers: [
        {
          provide: MessageBookmarksService,
          useFactory: (database: TenantDatabase) => new MessageBookmarksService(database),
          inject: [TENANT_DATABASE],
        },
      ],
      controllers: [MessageBookmarksController],
    };
  }
}
