'use client';

import type { GroupSystemMeta } from '../../lib/api/chat-groups';
import { useTOr } from '../../lib/i18n/use-t-or';
import './groups.css';

/** The English template of each system event; `{actor}` and `{users}` are filled in. */
const TEMPLATES: Record<string, string> = {
  member_added: '{actor} added {users}',
  member_removed: '{actor} removed {users}',
  member_left: '{users} left',
  member_joined: '{users} joined via invite link',
  admin_granted: '{users} is now an admin',
  admin_revoked: '{users} is no longer an admin',
  renamed: '{actor} renamed the group',
  settings_changed: '{actor} changed who can send messages',
};

export interface SystemMessageRowProps {
  /** The message's `meta` ({event, userIds}); null falls back to the stored body. */
  readonly meta: GroupSystemMeta | Record<string, unknown> | null;
  /** The stored plain-text body, used when the event is unknown to this screen. */
  readonly body: string | null;
  readonly actorName: string;
  /** Display names by user id, for the people the event names. */
  readonly nameOf: (userId: string) => string;
}

function asMeta(meta: SystemMessageRowProps['meta']): GroupSystemMeta | null {
  if (!meta || typeof meta['event'] !== 'string' || !Array.isArray(meta['userIds'])) return null;
  return meta as GroupSystemMeta;
}

/**
 * R7 slice 3 — "Peter added Sara": a centred, quiet pill in the transcript for a `kind = 'system'`
 * message (Figma "System message rows", 493:29341 / 493:29498). Rendered from `meta` in the
 * reader's language; the stored English body is only the fallback. Exported for slice 4's pane.
 */
export function SystemMessageRow({ meta, body, actorName, nameOf }: SystemMessageRowProps) {
  const tOr = useTOr();
  const parsed = asMeta(meta);
  const template = parsed ? TEMPLATES[parsed.event] : undefined;
  const text =
    parsed && template
      ? tOr(`ChatGroups.system.${parsed.event}`, template)
          .replace('{actor}', actorName)
          .replace('{users}', parsed.userIds.map(nameOf).join(tOr('ChatGroups.listJoin', ', ')))
      : (body ?? '');
  return (
    <div className="tm-chatgroup-sys" role="note">
      <span className="tm-chatgroup-sys__pill">{text}</span>
    </div>
  );
}
