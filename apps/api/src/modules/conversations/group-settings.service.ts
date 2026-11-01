import { randomBytes } from 'node:crypto';
import { authorize, isServableVersion } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type {
  ConversationMemberRole,
  ConversationMembershipRow,
  ConversationRow,
} from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { FileAssetsRepository } from '../files/file-assets.repository.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { ConversationsRepository } from './conversations.repository.js';
import { DirectConversationsRepository } from './direct-conversations.repository.js';
import { GroupSettingsRepository } from './group-settings.repository.js';
import type { GroupSettingsPatch } from './group-settings.repository.js';

/**
 * R7 slice 3 — groups: settings, members, admins, invite links and leave (F2).
 *
 * ## The gate
 *
 * A group is member-gated for everyone (slice 1): the caller's `conversation_memberships` row is
 * read first and handed to `authorize()` as the relation, exactly as `ConversationsService.mayReach`
 * does. No row, or a conversation that is not a group, is a 404 — a group's existence is itself
 * information. Changing the group (settings, members, roles, the invite link) also needs the
 * caller's `role = 'admin'`; a member who is not one is told 403, because they can already read it.
 *
 * ## System messages
 *
 * Every change writes a `kind = 'system'` message with `meta {event, userIds}` in the same
 * transaction, so the transcript and the change cannot disagree. `ConversationsService.postMessage`
 * refuses `system` from callers by design (`message-meta.ts`), so this service appends through the
 * repository and emits the same `message.created.v1` outbox event a post does.
 *
 * ## Clients
 *
 * An admin may add a client contact of this tenant (an active client membership). A client is
 * never made an admin, never promoted when the last admin leaves (an internal member is preferred),
 * and never joins by link: invite links are for internal members only.
 */

export type GroupSystemEvent =
  | 'member_added'
  | 'member_removed'
  | 'member_left'
  | 'member_joined'
  | 'admin_granted'
  | 'admin_revoked'
  | 'renamed'
  | 'settings_changed';

export interface GroupMemberView {
  readonly userId: string;
  readonly displayName: string;
  readonly role: ConversationMemberRole;
  readonly isClient: boolean;
  readonly joinedAt: string;
}

export interface GroupInfoView {
  readonly conversationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly photoFileAssetId: string | null;
  readonly onlyAdminsCanSend: boolean;
  readonly viewerRole: ConversationMemberRole;
  /** Only an admin sees the live token; null otherwise or when no link is live. */
  readonly inviteToken: string | null;
  readonly members: readonly GroupMemberView[];
}

export interface GroupInvitePreview {
  readonly conversationId: string;
  readonly name: string;
  readonly photoFileAssetId: string | null;
  readonly memberCount: number;
  readonly alreadyMember: boolean;
}

interface Gated {
  readonly row: ConversationRow;
  readonly membership: ConversationMembershipRow;
}

/** 32 random bytes, base64url: 43 characters, the width of `conversations.invite_token`. */
export function mintInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export class GroupSettingsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly groups: GroupSettingsRepository = new GroupSettingsRepository(),
    private readonly conversations: ConversationsRepository = new ConversationsRepository(),
    private readonly people: DirectConversationsRepository = new DirectConversationsRepository(),
    private readonly files: FileAssetsRepository = new FileAssetsRepository(),
    private readonly audit?: AuditService,
    private readonly outbox?: OutboxEventsRepository,
  ) {}

  async get(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<GroupInfoView> {
    const { row, membership } = await this.gate(context, principal, conversationId, 'read');
    return this.database.read(context, async (runner) => {
      const members = await this.groups.listMembersOldestFirst(runner, context, conversationId);
      const ids = members.map((m) => m.userId);
      const names = await this.people.displayNames(runner, ids);
      const clients = await this.groups.clientUserIds(runner, context, ids);
      return {
        conversationId: row.id,
        name: row.name,
        description: row.description,
        photoFileAssetId: row.photoFileAssetId,
        onlyAdminsCanSend: row.onlyAdminsCanSend === 1,
        viewerRole: membership.role,
        inviteToken: membership.role === 'admin' ? row.inviteToken : null,
        members: members.map((m) => ({
          userId: m.userId,
          displayName: names.get(m.userId) ?? '',
          role: m.role,
          isClient: clients.has(m.userId),
          joinedAt: m.createdAt.toISOString(),
        })),
      };
    });
  }

  async update(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    patch: GroupSettingsPatch,
  ): Promise<GroupInfoView> {
    const { row } = await this.gateAdmin(context, principal, conversationId);
    await this.database.transaction(context, async (tx) => {
      if (patch.photoFileAssetId) {
        await this.requireReadablePhoto(tx, context, principal, patch.photoFileAssetId);
      }
      await this.groups.updateSettings(tx, context, conversationId, patch);
      if (patch.name !== undefined && patch.name !== row.name) {
        await this.postSystem(tx, context, row, 'renamed', []);
      }
      if (
        patch.onlyAdminsCanSend !== undefined &&
        patch.onlyAdminsCanSend !== (row.onlyAdminsCanSend === 1)
      ) {
        await this.postSystem(tx, context, row, 'settings_changed', []);
      }
    });
    return this.get(context, principal, conversationId);
  }

  async addMember(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    userId: string,
  ): Promise<GroupInfoView> {
    const { row } = await this.gateAdmin(context, principal, conversationId);
    await this.database.transaction(context, async (tx) => {
      const party = await this.people.findParty(tx, context, userId);
      if (!party) {
        throw new ApiError(422, 'validation_failed', 'That person is not in this company', [
          { field: 'userId', message: 'must be an active member or client contact here' },
        ]);
      }
      const existing = await this.conversations.findMembership(tx, context, row.id, userId);
      if (existing) return;
      await this.conversations.addMember(tx, context, row.id, userId);
      await this.audit?.record(tx, context, {
        action: 'conversation.member_added',
        objectId: row.id,
        result: 'allowed',
        metadata: { target_user_id: userId },
      });
      await this.postSystem(tx, context, row, 'member_added', [userId]);
    });
    return this.get(context, principal, conversationId);
  }

  async removeMember(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    userId: string,
  ): Promise<void> {
    if (userId === principal.userId) {
      await this.leave(context, principal, conversationId);
      return;
    }
    const { row } = await this.gateAdmin(context, principal, conversationId);
    await this.database.transaction(context, async (tx) => {
      const removed = await this.conversations.removeMember(tx, context, row.id, userId);
      if (!removed) return;
      await this.audit?.record(tx, context, {
        action: 'conversation.member_removed',
        objectId: row.id,
        result: 'allowed',
        metadata: { target_user_id: userId },
      });
      await this.postSystem(tx, context, row, 'member_removed', [userId]);
    });
  }

  async setRole(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    userId: string,
    role: ConversationMemberRole,
  ): Promise<GroupInfoView> {
    const { row } = await this.gateAdmin(context, principal, conversationId);
    await this.database.transaction(context, async (tx) => {
      const target = await this.conversations.findMembership(tx, context, row.id, userId);
      if (!target) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      if (target.role === role) return;
      if (role === 'admin') {
        const clients = await this.groups.clientUserIds(tx, context, [userId]);
        if (clients.has(userId)) {
          throw new ApiError(422, 'validation_failed', 'A client contact cannot be a group admin', [
            { field: 'role', message: 'clients stay members' },
          ]);
        }
      } else {
        const members = await this.groups.listMembersOldestFirst(tx, context, row.id);
        if (members.filter((m) => m.role === 'admin').length <= 1) {
          throw new ApiError(409, 'conflict', 'A group needs at least one admin');
        }
      }
      await this.groups.setRole(tx, context, row.id, userId, role);
      await this.postSystem(
        tx,
        context,
        row,
        role === 'admin' ? 'admin_granted' : 'admin_revoked',
        [userId],
      );
    });
    return this.get(context, principal, conversationId);
  }

  /**
   * The caller leaves. When they were the last admin, the oldest remaining member is promoted —
   * an internal member first, because a client is never an admin.
   */
  async leave(context: TenantContext, principal: Principal, conversationId: string): Promise<void> {
    const { row, membership } = await this.gate(context, principal, conversationId, 'read');
    await this.database.transaction(context, async (tx) => {
      await this.conversations.removeMember(tx, context, row.id, principal.userId);
      await this.audit?.record(tx, context, {
        action: 'conversation.member_removed',
        objectId: row.id,
        result: 'allowed',
        metadata: { target_user_id: principal.userId },
      });
      await this.postSystem(tx, context, row, 'member_left', [principal.userId]);
      if (membership.role !== 'admin') return;

      const remaining = await this.groups.listMembersOldestFirst(tx, context, row.id);
      if (remaining.length === 0 || remaining.some((m) => m.role === 'admin')) return;
      const clients = await this.groups.clientUserIds(
        tx,
        context,
        remaining.map((m) => m.userId),
      );
      const heir = remaining.find((m) => !clients.has(m.userId));
      if (!heir) return;
      await this.groups.setRole(tx, context, row.id, heir.userId, 'admin');
      await this.postSystem(tx, context, row, 'admin_granted', [heir.userId]);
    });
  }

  async createInvite(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<{ readonly inviteToken: string }> {
    await this.gateAdmin(context, principal, conversationId);
    const token = mintInviteToken();
    await this.database.transaction(context, (tx) =>
      this.groups.setInviteToken(tx, context, conversationId, token),
    );
    return { inviteToken: token };
  }

  async revokeInvite(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<void> {
    await this.gateAdmin(context, principal, conversationId);
    await this.database.transaction(context, (tx) =>
      this.groups.setInviteToken(tx, context, conversationId, null),
    );
  }

  async previewInvite(
    context: TenantContext,
    principal: Principal,
    token: string,
  ): Promise<GroupInvitePreview> {
    this.requireInternal(principal);
    return this.database.read(context, async (runner) => {
      const row = await this.groups.findGroupByInviteToken(runner, context, token);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      const mine = await this.conversations.findMembership(
        runner,
        context,
        row.id,
        principal.userId,
      );
      return {
        conversationId: row.id,
        name: row.name,
        photoFileAssetId: row.photoFileAssetId,
        memberCount: await this.groups.countMembers(runner, context, row.id),
        alreadyMember: mine !== null,
      };
    });
  }

  /** Internal members only: a client never joins by link, only when an admin adds them. */
  async joinByInvite(
    context: TenantContext,
    principal: Principal,
    token: string,
  ): Promise<{ readonly conversationId: string }> {
    this.requireInternal(principal);
    return this.database.transaction(context, async (tx) => {
      const row = await this.groups.findGroupByInviteToken(tx, context, token);
      if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      const existing = await this.conversations.findMembership(
        tx,
        context,
        row.id,
        principal.userId,
      );
      if (!existing) {
        await this.conversations.addMember(tx, context, row.id, principal.userId);
        await this.audit?.record(tx, context, {
          action: 'conversation.member_added',
          objectId: row.id,
          result: 'allowed',
          metadata: { target_user_id: principal.userId },
        });
        await this.postSystem(tx, context, row, 'member_joined', [principal.userId]);
      }
      return { conversationId: row.id };
    });
  }

  // ── Gates ──────────────────────────────────────────────────────────────────

  private requireInternal(principal: Principal): void {
    if (principal.kind !== 'internal') {
      throw new ApiError(403, 'forbidden', 'Invite links are for team members only');
    }
  }

  private async gateAdmin(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
  ): Promise<Gated> {
    const gated = await this.gate(context, principal, conversationId, 'write');
    if (gated.membership.role !== 'admin') {
      throw new ApiError(403, 'forbidden', 'Only group admins can change the group');
    }
    return gated;
  }

  private async gate(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    access: 'read' | 'write',
  ): Promise<Gated> {
    const found = await this.database.read(context, async (runner) => {
      const row = await this.conversations.findById(runner, context, conversationId);
      if (!row || row.kind !== 'group') return null;
      const membership = await this.conversations.findMembership(
        runner,
        context,
        row.id,
        principal.userId,
      );
      return { row, membership };
    });
    if (!found || !found.membership) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const capability: Capability = access === 'read' ? 'conversation.read' : 'conversation.write';
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: found.row.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: found.row.archivedAt === null ? 'active' : 'archived',
        conversationKind: 'group',
        conversationMember: true,
      },
    });
    if (!verdict.allowed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return { row: found.row, membership: found.membership };
  }

  /** The photo must be a servable (scanned clean) file the caller may download. */
  private async requireReadablePhoto(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    fileAssetId: string,
  ): Promise<void> {
    const found = await this.files.findWithLatestVersion(runner, context, fileAssetId);
    const servable =
      found !== null &&
      found.version !== null &&
      isServableVersion({
        status: found.asset.status,
        scanVerdict: found.version.scanVerdict,
        trustZone: found.version.trustZone,
      });
    if (!found || !servable) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const verdict = authorize({
      principal,
      capability: 'file.download',
      resource: {
        organizationId: found.asset.organizationId,
        projectId: found.asset.projectId,
        audience: found.asset.audience,
        clientOrganizationId: found.asset.clientOrganizationId,
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  }

  // ── System messages ────────────────────────────────────────────────────────

  private async postSystem(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: ConversationRow,
    event: GroupSystemEvent,
    userIds: readonly string[],
  ): Promise<void> {
    const names = await this.people.displayNames(runner, [context.userId, ...userIds]);
    const appended = await this.conversations.appendMessage(runner, context, {
      conversationId: row.id,
      authorUserId: context.userId,
      body: systemBody(
        event,
        names.get(context.userId) ?? '',
        userIds.map((id) => names.get(id) ?? ''),
      ),
      kind: 'system',
      meta: { event, userIds: [...userIds] },
    });
    await this.outbox?.append(runner, context, {
      type: 'message.created.v1',
      aggregateId: row.id,
      payload: {
        messageId: appended.id,
        conversationId: row.id,
        projectId: null,
        parentMessageId: null,
        sequenceNo: Number(appended.sequenceNo),
        mentionedUserIds: [],
        authorUserId: context.userId,
      },
    });
  }
}

/**
 * The plain-text body a system message stores (`messages.body` is NOT NULL, and search and the
 * chat list's excerpt read it). Screens render from `meta` in the reader's language instead.
 */
export function systemBody(
  event: GroupSystemEvent,
  actor: string,
  targets: readonly string[],
): string {
  const who = targets.join(', ');
  switch (event) {
    case 'member_added':
      return `${actor} added ${who}`;
    case 'member_removed':
      return `${actor} removed ${who}`;
    case 'member_left':
      return `${who} left`;
    case 'member_joined':
      return `${who} joined via invite link`;
    case 'admin_granted':
      return `${who} is now an admin`;
    case 'admin_revoked':
      return `${who} is no longer an admin`;
    case 'renamed':
      return `${actor} renamed the group`;
    case 'settings_changed':
      return `${actor} changed who can send messages`;
  }
}
