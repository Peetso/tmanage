import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import { CONTENT_BASE, PLATFORM_CONTENT_SERVICE, supportRequestOf } from './content-http.js';
import type { ContentQuery, EditBody, PlatformContentService } from './content.service.js';

/**
 * B5 Chats and DMs (SPEC §5.4): the browser's landing read, channels and DM conversations, a
 * conversation's messages, and one message's edit / delete (reason required) / restore. A DM's
 * message is addressed with `?kind=dm`. Every call needs a live Support session (428 otherwise).
 */
@Controller(CONTENT_BASE)
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformConversationsContentController {
  constructor(@Inject(PLATFORM_CONTENT_SERVICE) private readonly content: PlatformContentService) {}

  /** The browser's header: the organization, the live session, the counts on the area tabs. */
  @Get()
  @RequirePlatformPermission('platform.content.view')
  home(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Req() request: object,
  ) {
    return this.content.home(actor, id, supportRequestOf(request));
  }

  @Get('conversations')
  @RequirePlatformPermission('platform.content.view')
  conversations(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Query() query: ContentQuery,
    @Req() request: object,
  ) {
    const area = query?.['kind'] === 'dm' ? 'dms' : 'chats';
    return this.content.list(actor, id, area, query ?? {}, supportRequestOf(request));
  }

  @Get('conversations/:conversationId/messages')
  @RequirePlatformPermission('platform.content.view')
  messages(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('conversationId') conversationId: string,
    @Query() query: ContentQuery,
    @Req() request: object,
  ) {
    return this.content.messages(actor, id, conversationId, query ?? {}, supportRequestOf(request));
  }

  @Get('messages/:messageId')
  @RequirePlatformPermission('platform.content.view')
  message(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Query('kind') kind: string | undefined,
    @Req() request: object,
  ) {
    return this.content.item(actor, id, messageKind(kind), messageId, supportRequestOf(request));
  }

  @Patch('messages/:messageId')
  @RequirePlatformPermission('platform.content.moderate')
  edit(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Query('kind') kind: string | undefined,
    @Body() body: EditBody,
    @Req() request: object,
  ) {
    return this.content.edit(
      actor,
      id,
      messageKind(kind),
      messageId,
      body ?? {},
      supportRequestOf(request),
    );
  }

  @Delete('messages/:messageId')
  @RequirePlatformPermission('platform.content.moderate')
  remove(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Query('kind') kind: string | undefined,
    @Body() body: { readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.content.remove(
      actor,
      id,
      messageKind(kind),
      messageId,
      body ?? {},
      supportRequestOf(request),
    );
  }

  @Post('messages/:messageId/restore')
  @RequirePlatformPermission('platform.content.moderate')
  @HttpCode(200)
  restore(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Query('kind') kind: string | undefined,
    @Body() body: { readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.content.restore(
      actor,
      id,
      messageKind(kind),
      messageId,
      body ?? {},
      supportRequestOf(request),
    );
  }
}

function messageKind(kind: string | undefined): 'message' | 'direct_message' {
  return kind === 'dm' || kind === 'direct_message' ? 'direct_message' : 'message';
}
