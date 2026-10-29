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
 * B5/B6 Comments of every kind (SPEC §5.4): `comments?objectType&objectId&author&deleted`, and
 * `comments/:kind/:commentId` where `kind` is `work`, `doc`, `decision`, `file`, `request` or
 * `update`. A comment is append-only (0245 trigger): PATCH explains that and changes nothing;
 * delete (reason required) and restore work like everywhere else.
 */
@Controller(CONTENT_BASE)
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformCommentsContentController {
  constructor(@Inject(PLATFORM_CONTENT_SERVICE) private readonly content: PlatformContentService) {}

  @Get('comments')
  @RequirePlatformPermission('platform.content.view')
  list(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Query() query: ContentQuery,
    @Req() request: object,
  ) {
    return this.content.list(actor, id, 'comments', query ?? {}, supportRequestOf(request));
  }

  @Get('comments/:kind/:commentId')
  @RequirePlatformPermission('platform.content.view')
  item(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Param('commentId') commentId: string,
    @Req() request: object,
  ) {
    return this.content.item(actor, id, commentKind(kind), commentId, supportRequestOf(request));
  }

  @Patch('comments/:kind/:commentId')
  @RequirePlatformPermission('platform.content.moderate')
  edit(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Param('commentId') commentId: string,
    @Body() body: EditBody,
    @Req() request: object,
  ) {
    return this.content.edit(
      actor,
      id,
      commentKind(kind),
      commentId,
      body ?? {},
      supportRequestOf(request),
    );
  }

  @Delete('comments/:kind/:commentId')
  @RequirePlatformPermission('platform.content.moderate')
  remove(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Param('commentId') commentId: string,
    @Body() body: { readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.content.remove(
      actor,
      id,
      commentKind(kind),
      commentId,
      body ?? {},
      supportRequestOf(request),
    );
  }

  @Post('comments/:kind/:commentId/restore')
  @RequirePlatformPermission('platform.content.moderate')
  @HttpCode(200)
  restore(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Param('commentId') commentId: string,
    @Body() body: { readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.content.restore(
      actor,
      id,
      commentKind(kind),
      commentId,
      body ?? {},
      supportRequestOf(request),
    );
  }
}

/** `work` → `work_comment`; an unknown kind becomes a kind the service answers 404 for. */
function commentKind(kind: string): string {
  return kind.endsWith('_comment') ? kind : `${kind}_comment`;
}
