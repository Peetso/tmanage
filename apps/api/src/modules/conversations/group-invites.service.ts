import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { GroupInvitePreview, GroupSettingsService } from './group-settings.service.js';

/**
 * R7 slice 3 — the invite link's door. A thin facade over `GroupSettingsService`, which owns the
 * token column, the membership insert and the `member_joined` system message, so the link and the
 * group's own settings can never disagree about who may join (internal members only).
 */
export class GroupInvitesService {
  constructor(private readonly groups: GroupSettingsService) {}

  preview(
    context: TenantContext,
    principal: Principal,
    token: string,
  ): Promise<GroupInvitePreview> {
    return this.groups.previewInvite(context, principal, token);
  }

  join(
    context: TenantContext,
    principal: Principal,
    token: string,
  ): Promise<{ readonly conversationId: string }> {
    return this.groups.joinByInvite(context, principal, token);
  }
}
