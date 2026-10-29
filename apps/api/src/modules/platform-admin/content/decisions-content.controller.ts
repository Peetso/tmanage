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
 * B5/B6 Decisions (SPEC §5.4): the list (`?q&projectId&deleted`), one item with its history,
 * edit ("why we decided this"; a locked decision refuses it), delete (reason required, soft) and restore. Every call needs a live Support
 * session for the organization (428 otherwise).
 */
@Controller(CONTENT_BASE)
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformDecisionsContentController {
  constructor(@Inject(PLATFORM_CONTENT_SERVICE) private readonly content: PlatformContentService) {}

  @Get('decisions')
  @RequirePlatformPermission('platform.content.view')
  list(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Query() query: ContentQuery,
    @Req() request: object,
  ) {
    return this.content.list(actor, id, 'decisions', query ?? {}, supportRequestOf(request));
  }

  @Get('decisions/:itemId')
  @RequirePlatformPermission('platform.content.view')
  item(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Req() request: object,
  ) {
    return this.content.item(actor, id, 'decision', itemId, supportRequestOf(request));
  }

  @Patch('decisions/:itemId')
  @RequirePlatformPermission('platform.content.moderate')
  edit(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: EditBody,
    @Req() request: object,
  ) {
    return this.content.edit(actor, id, 'decision', itemId, body ?? {}, supportRequestOf(request));
  }

  @Delete('decisions/:itemId')
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
      'decision',
      itemId,
      body ?? {},
      supportRequestOf(request),
    );
  }

  @Post('decisions/:itemId/restore')
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
      'decision',
      itemId,
      body ?? {},
      supportRequestOf(request),
    );
  }
}
