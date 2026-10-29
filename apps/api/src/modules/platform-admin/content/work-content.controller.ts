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
 * B5/B6 Work items (SPEC §5.4): the list (`?q&projectId&state&assignee&deleted`), one item with its history,
 * edit (title, description, state, assignee, due — through the work service), delete (reason required, soft) and restore. Every call needs a live Support
 * session for the organization (428 otherwise).
 */
@Controller(CONTENT_BASE)
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformWorkContentController {
  constructor(@Inject(PLATFORM_CONTENT_SERVICE) private readonly content: PlatformContentService) {}

  @Get('work-items')
  @RequirePlatformPermission('platform.content.view')
  list(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Query() query: ContentQuery,
    @Req() request: object,
  ) {
    return this.content.list(actor, id, 'work_items', query ?? {}, supportRequestOf(request));
  }

  @Get('work-items/:itemId')
  @RequirePlatformPermission('platform.content.view')
  item(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Req() request: object,
  ) {
    return this.content.item(actor, id, 'work_item', itemId, supportRequestOf(request));
  }

  @Patch('work-items/:itemId')
  @RequirePlatformPermission('platform.content.moderate')
  edit(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: EditBody,
    @Req() request: object,
  ) {
    return this.content.edit(actor, id, 'work_item', itemId, body ?? {}, supportRequestOf(request));
  }

  @Delete('work-items/:itemId')
  @RequirePlatformPermission('platform.content.moderate')
  remove(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: { readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.content.remove(
      actor,
      id,
      'work_item',
      itemId,
      body ?? {},
      supportRequestOf(request),
    );
  }

  @Post('work-items/:itemId/restore')
  @RequirePlatformPermission('platform.content.moderate')
  @HttpCode(200)
  restore(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: { readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.content.restore(
      actor,
      id,
      'work_item',
      itemId,
      body ?? {},
      supportRequestOf(request),
    );
  }
}
