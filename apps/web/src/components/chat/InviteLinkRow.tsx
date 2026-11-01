'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import {
  createGroupInvite,
  groupKeys,
  inviteLinkFor,
  revokeGroupInvite,
} from '../../lib/api/chat-groups';
import { useTOr } from '../../lib/i18n/use-t-or';
import './groups.css';

export interface InviteLinkRowProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly conversationId: string;
  /** The live token, or null when the group has no link yet. */
  readonly inviteToken: string | null;
}

/**
 * R7 slice 3 — the group's invite link for admins: the link with Copy and Reset (a new token, so
 * the old link stops working), Turn off, or "Create invite link" when there is none. Team members
 * only can join by it; the server refuses client contacts.
 */
export function InviteLinkRow({
  api,
  organizationSlug,
  conversationId,
  inviteToken,
}: InviteLinkRowProps) {
  const tOr = useTOr();
  const queries = useQueryClient();
  const [copied, setCopied] = useState(false);
  const refresh = () =>
    queries.invalidateQueries({ queryKey: groupKeys.info(organizationSlug, conversationId) });
  const mint = useMutation({
    mutationFn: () => createGroupInvite(api, organizationSlug, conversationId),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: () => revokeGroupInvite(api, organizationSlug, conversationId),
    onSuccess: refresh,
  });
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const link = inviteToken ? inviteLinkFor(origin, organizationSlug, inviteToken) : null;

  async function copy(): Promise<void> {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="tm-chatgroup-invite">
      <p className="tm-chatgroup__label">{tOr('ChatGroups.inviteLink', 'Invite link')}</p>
      {link ? (
        <div className="tm-chatgroup-invite__row">
          <span className="tm-chatgroup-invite__link" dir="ltr">
            {link}
          </span>
          <button type="button" className="tm-chatgroup__btn" onClick={() => void copy()}>
            {copied ? tOr('ChatGroups.copied', 'Copied') : tOr('ChatGroups.copy', 'Copy')}
          </button>
          <button
            type="button"
            className="tm-chatgroup__btn"
            disabled={mint.isPending}
            onClick={() => mint.mutate()}
          >
            {tOr('ChatGroups.reset', 'Reset')}
          </button>
          <button
            type="button"
            className="tm-chatgroup__btn tm-chatgroup__btn--quiet"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            {tOr('ChatGroups.turnOff', 'Turn off')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="tm-chatgroup__btn"
          disabled={mint.isPending}
          onClick={() => mint.mutate()}
        >
          {tOr('ChatGroups.createInvite', 'Create invite link')}
        </button>
      )}
      <p className="tm-chatgroup__hint">
        {tOr(
          'ChatGroups.inviteHint',
          'Team members with the link can join. Clients are added by an admin.',
        )}
      </p>
    </div>
  );
}
