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
  Put,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ConversationMemberRole } from '../../common/database/schema.js';
import type { GroupSettingsPatch } from './group-settings.repository.js';
import type { GroupInfoView, GroupSettingsService } from './group-settings.service.js';

/** R7 slice 3: the token `ConversationGroupModule` provides `GroupSettingsService` under. */
export const GROUP_SETTINGS_SERVICE = Symbol.for('tmanage.GroupSettingsService');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * R7 slice 3 — a group's own surface: info, settings, members, admin roles, leave and the invite
 * link. Reads and leave sit behind `conversation.read`; every change behind `conversation.write`,
 * and the service additionally requires the caller to be one of the group's admins.
 */
@Controller('v1/organizations/:orgSlug/conversations/:conversationId/group')
export class GroupSettingsController {
  constructor(@Inject(GROUP_SETTINGS_SERVICE) private readonly groups: GroupSettingsService) {}

  @Get()
  @RequireCapability('conversation.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<GroupInfoView> {
    return this.groups.get(context, principal, conversationId);
  }

  @Patch()
  @RequireCapability('conversation.write')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<GroupInfoView> {
    return this.groups.update(context, principal, conversationId, parseSettingsPatch(body));
  }

  @Post('members')
  @RequireCapability('conversation.write')
  @HttpCode(200)
  async addMember(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<GroupInfoView> {
    return this.groups.addMember(context, principal, conversationId, parseUserId(body));
  }

  @Delete('members/:userId')
  @RequireCapability('conversation.write')
  @HttpCode(204)
  async removeMember(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.groups.removeMember(context, principal, conversationId, userId);
  }

  @Put('members/:userId/role')
  @RequireCapability('conversation.write')
  async setRole(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<GroupInfoView> {
    return this.groups.setRole(context, principal, conversationId, userId, parseRole(body));
  }

  @Post('leave')
  @RequireCapability('conversation.read')
  @HttpCode(204)
  async leave(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<void> {
    await this.groups.leave(context, principal, conversationId);
  }

  @Post('invite')
  @RequireCapability('conversation.write')
  @HttpCode(200)
  async createInvite(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<{ readonly inviteToken: string }> {
    return this.groups.createInvite(context, principal, conversationId);
  }

  @Delete('invite')
  @RequireCapability('conversation.write')
  @HttpCode(204)
  async revokeInvite(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<void> {
    await this.groups.revokeInvite(context, principal, conversationId);
  }
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

/** `{name?, description?, photoFileAssetId?, onlyAdminsCanSend?}` — at least one field. */
export function parseSettingsPatch(body: unknown): GroupSettingsPatch {
  const value = asRecord(body);
  const patch: { -readonly [K in keyof GroupSettingsPatch]: GroupSettingsPatch[K] } = {};
  if ('name' in value) {
    const name = value['name'];
    if (typeof name !== 'string' || name.trim() === '' || name.length > 120) {
      throw invalid('name', 'must be 1 to 120 characters');
    }
    patch.name = name.trim();
  }
  if ('description' in value) {
    const description = value['description'];
    if (description !== null && (typeof description !== 'string' || description.length > 500)) {
      throw invalid('description', 'must be null or at most 500 characters');
    }
    patch.description = description === null || description === '' ? null : description;
  }
  if ('photoFileAssetId' in value) {
    const photo = value['photoFileAssetId'];
    if (photo !== null && (typeof photo !== 'string' || !UUID.test(photo))) {
      throw invalid('photoFileAssetId', 'must be null or a file id');
    }
    patch.photoFileAssetId = photo;
  }
  if ('onlyAdminsCanSend' in value) {
    const only = value['onlyAdminsCanSend'];
    if (typeof only !== 'boolean') throw invalid('onlyAdminsCanSend', 'must be a boolean');
    patch.onlyAdminsCanSend = only;
  }
  if (Object.keys(patch).length === 0) throw invalid('body', 'names no setting to change');
  return patch;
}

function parseUserId(body: unknown): string {
  const userId = asRecord(body)['userId'];
  if (typeof userId !== 'string' || !UUID.test(userId))
    throw invalid('userId', 'must be a user id');
  return userId;
}

function parseRole(body: unknown): ConversationMemberRole {
  const role = asRecord(body)['role'];
  if (role !== 'admin' && role !== 'member') throw invalid('role', "must be 'admin' or 'member'");
  return role;
}
