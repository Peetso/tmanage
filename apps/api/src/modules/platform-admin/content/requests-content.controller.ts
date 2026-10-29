import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
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
import type { ContentQuery, PlatformContentService } from './content.service.js';

/**
 * B5 Requests (SPEC §5.4): client requests are read only here; their messages can be taken down
 * (reason required) and restored. A request message is append-only, so there is no edit.
 */
@Controller(CONTENT_BASE)
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformRequestsContentController {
  constructor(@Inject(PLATFORM_CONTENT_SERVICE) private readonly content: PlatformContentService) {}

  @Get('requests')
  @RequirePlatformPermission('platform.content.view')
  list(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Query() query: ContentQuery,
    @Req() request: object,
  ) {
    return this.content.list(actor, id, 'requests', query ?? {}, supportRequestOf(request));
  }

  @Get('requests/:requestId/messages')
  @RequirePlatformPermission('platform.content.view')
  messages(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Query() query: ContentQuery,
    @Req() request: object,
  ) {
    return this.content.messages(
      actor,
      id,
      requestId,
      { ...(query ?? {}), kind: 'request' },
      supportRequestOf(request),
    );
  }

  @Get('request-messages/:messageId')
  @RequirePlatformPermission('platform.content.view')
  item(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Req() request: object,
  ) {
    return this.content.item(actor, id, 'request_message', messageId, supportRequestOf(request));
  }

  @Delete('request-messages/:messageId')
  @RequirePlatformPermission('platform.content.moderate')
  remove(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() body: { readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.content.remove(
      actor,
      id,
      'request_message',
      messageId,
      body ?? {},
      supportRequestOf(request),
    );
  }

  @Post('request-messages/:messageId/restore')
  @RequirePlatformPermission('platform.content.moderate')
  @HttpCode(200)
  restore(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() body: { readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.content.restore(
      actor,
      id,
      'request_message',
      messageId,
      body ?? {},
      supportRequestOf(request),
    );
  }
}
