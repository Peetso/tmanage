'use client';

import type { MemberSummary } from '../../../lib/api/members';
import type { WorkComment } from '../../../lib/api/work-items';
import type { WorkActivityEntry } from '../../../lib/api/work-activity';
import { AiAvatar, AiBadge, aiInitialsOf } from '../../ai-employees/AiBadge';
import '../ai-people.css';

/**
 * 60-08 (plan 60 v2 S7c pattern) — who did an Activity-tab entry, when an AI employee did it: his
 * square avatar, his name and the AI mark, before the entry's words. A person's entry is shown as
 * before (the tab names no one), so only the AI employee's work gains a name.
 *
 * `actorId` is a user id for an audited move and an author membership for a comment; a comment's
 * membership is read back to its user through the item's own comments.
 */
export function aiActorOf(
  entry: WorkActivityEntry,
  members: readonly MemberSummary[],
  comments: readonly WorkComment[],
): MemberSummary | null {
  if (entry.actorId === null) return null;
  const userId =
    entry.kind === 'comment'
      ? (comments.find((comment) => comment.authorMembershipId === entry.actorId)?.authorUserId ??
        null)
      : entry.actorId;
  if (userId === null) return null;
  return members.find((member) => member.userId === userId && member.kind === 'ai') ?? null;
}

export function WorkActivityWho({ member }: { readonly member: MemberSummary }) {
  return (
    <span className="tm-ai-activity__who" data-testid="activity-ai-actor">
      <AiAvatar initials={aiInitialsOf(member.displayName)} />
      <bdi>{member.displayName}</bdi>
      <AiBadge />
    </span>
  );
}
