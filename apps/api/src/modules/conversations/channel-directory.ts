import type { ChannelDirectoryFacts } from './channel-directory.repository.js';
import type { ConversationView } from './conversations.service.js';

/** How many member avatars a row draws before the count takes over (CH-01 shows three). */
export const MEMBER_PREVIEW_SIZE = 3;

export interface ChannelMemberPreview {
  readonly userId: string;
  readonly displayName: string;
  readonly isClient: boolean;
}

/** One row of the channel browser. */
export interface ChannelDirectoryEntry extends ConversationView {
  /** The newest message, or the channel's creation when nobody has written in it yet. */
  readonly lastActivityAt: string;
  readonly memberCount: number;
  /** Members holding a live client membership; above zero means the channel is client shared. */
  readonly clientMemberCount: number;
  /** Whether the viewer is a member — CH-01's "joined" tag and the "My channels" filter. */
  readonly joined: boolean;
  readonly memberPreview: readonly ChannelMemberPreview[];
}

/**
 * Join the reachable conversations to their facts and order them by last activity, newest first.
 *
 * Ties (same instant) fall back to the name so the order is stable between two reads. The preview
 * puts the viewer and internal members first and clients last, as the CH-01 avatars do.
 */
export function buildChannelDirectory(
  conversations: readonly ConversationView[],
  facts: ChannelDirectoryFacts,
  viewerUserId: string,
): readonly ChannelDirectoryEntry[] {
  const entries = conversations.map((conversation): ChannelDirectoryEntry => {
    const members = facts.members
      .filter((member) => member.conversationId === conversation.id)
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
    const preview = members
      .map((member) => ({
        userId: member.userId,
        displayName: member.displayName,
        isClient: facts.clientUserIds.has(member.userId),
      }))
      .sort((a, b) => Number(a.isClient) - Number(b.isClient));
    const last = facts.lastMessageAt.get(conversation.id);

    return {
      ...conversation,
      lastActivityAt: last ? last.toISOString() : conversation.createdAt,
      memberCount: members.length,
      clientMemberCount: preview.filter((member) => member.isClient).length,
      joined: members.some((member) => member.userId === viewerUserId),
      memberPreview: preview.slice(0, MEMBER_PREVIEW_SIZE),
    };
  });

  return entries.sort(
    (a, b) =>
      Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) || a.name.localeCompare(b.name),
  );
}
