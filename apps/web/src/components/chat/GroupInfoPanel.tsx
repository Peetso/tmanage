'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import {
  addGroupMember,
  getGroupInfo,
  groupKeys,
  leaveGroup,
  removeGroupMember,
  setGroupMemberRole,
  updateGroup,
  type GroupInfo,
} from '../../lib/api/chat-groups';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useMembers } from '../../lib/use-members';
import { initialsOf } from './channel-browser';
import { InviteLinkRow } from './InviteLinkRow';
import './groups.css';

export interface GroupInfoPanelProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly conversationId: string;
  /** Where "Leave group" lands — the chat list of the door the panel is open in. */
  readonly afterLeaveHref: string;
  /** Test seam / pre-read: the info to show before (or instead of) the query. */
  readonly initial?: GroupInfo;
  readonly onClose?: () => void;
}

/**
 * R7 slice 3 — the group info panel (Figma 493:29290 / 493:29447): photo, name, member count and
 * description; "Only admins can send"; the invite link; the members with Admin and Client chips;
 * Add members and Leave group. Admin-only controls are hidden for members — the server refuses
 * them anyway (403) — and a client contact is never offered "Make admin".
 */
export function GroupInfoPanel({
  api,
  organizationSlug,
  conversationId,
  afterLeaveHref,
  initial,
  onClose,
}: GroupInfoPanelProps) {
  const tOr = useTOr();
  const router = useRouter();
  const queries = useQueryClient();
  const key = groupKeys.info(organizationSlug, conversationId);
  const info = useQuery({
    queryKey: key,
    queryFn: () => getGroupInfo(api, organizationSlug, conversationId),
    ...(initial ? { initialData: initial } : {}),
  });
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const people = useMembers(api, organizationSlug, adding ? search : '');

  const settle = (next?: GroupInfo) => {
    if (next) queries.setQueryData(key, next);
    else void queries.invalidateQueries({ queryKey: key });
  };
  const change = useMutation({
    mutationFn: (run: () => Promise<GroupInfo | void>) => run(),
    onSuccess: (next) => settle(next ?? undefined),
  });
  const leave = useMutation({
    mutationFn: () => leaveGroup(api, organizationSlug, conversationId),
    onSuccess: () => router.push(afterLeaveHref),
  });

  const group = info.data;
  if (!group) {
    return (
      <aside className="tm-chatgroup-info" aria-busy="true">
        {info.isError ? tOr('ChatGroups.loadError', 'This group could not be loaded.') : null}
      </aside>
    );
  }
  const admin = group.viewerRole === 'admin';
  const memberIds = new Set(group.members.map((m) => m.userId));
  const candidates = people.members.filter((m) => !memberIds.has(m.userId)).slice(0, 8);

  return (
    <aside className="tm-chatgroup-info" aria-label={tOr('ChatGroups.info', 'Group info')}>
      {onClose ? (
        <button type="button" className="tm-chatgroup__close" onClick={onClose}>
          {tOr('ChatGroups.close', 'Close')}
        </button>
      ) : null}
      <header className="tm-chatgroup-info__head">
        <span className="tm-chatgroup__avatar tm-chatgroup__avatar--lg" aria-hidden="true">
          {initialsOf(group.name)}
        </span>
        <h2 className="tm-chatgroup-info__name">{group.name}</h2>
        <p className="tm-chatgroup__hint">
          {tOr('ChatGroups.memberCount', 'Group · {count} members').replace(
            '{count}',
            String(group.members.length),
          )}
        </p>
        {group.description ? <p className="tm-chatgroup-info__desc">{group.description}</p> : null}
      </header>

      {admin ? (
        <>
          <p className="tm-chatgroup__label">{tOr('ChatGroups.settings', 'Settings')}</p>
          <div className="tm-chatgroup-toggle">
            <span>
              <span className="tm-chatgroup-toggle__title">
                {tOr('ChatGroups.onlyAdmins', 'Only admins can send')}
              </span>
              <span className="tm-chatgroup__hint">
                {tOr('ChatGroups.onlyAdminsHint', 'Members can read and react only')}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-label={tOr('ChatGroups.onlyAdmins', 'Only admins can send')}
              checked={group.onlyAdminsCanSend}
              onChange={(event) => {
                const onlyAdminsCanSend = event.target.checked;
                change.mutate(() =>
                  updateGroup(api, organizationSlug, conversationId, { onlyAdminsCanSend }),
                );
              }}
            />
          </div>
          <InviteLinkRow
            api={api}
            organizationSlug={organizationSlug}
            conversationId={conversationId}
            inviteToken={group.inviteToken}
          />
        </>
      ) : null}

      <p className="tm-chatgroup__label">{tOr('ChatGroups.members', 'Members')}</p>
      <ul className="tm-chatgroup-members">
        {group.members.map((member) => (
          <li key={member.userId} className="tm-chatgroup-member">
            <span className="tm-chatgroup__avatar" aria-hidden="true">
              {initialsOf(member.displayName)}
            </span>
            <span className="tm-chatgroup-member__name">{member.displayName}</span>
            {member.role === 'admin' ? (
              <span className="tm-chatgroup__chip">{tOr('ChatGroups.admin', 'Admin')}</span>
            ) : null}
            {member.isClient ? (
              <span className="tm-chatgroup__chip tm-chatgroup__chip--client">
                {tOr('ChatGroups.client', 'Client')}
              </span>
            ) : null}
            {admin && !member.isClient ? (
              <button
                type="button"
                className="tm-chatgroup__btn tm-chatgroup__btn--quiet"
                onClick={() =>
                  change.mutate(() =>
                    setGroupMemberRole(
                      api,
                      organizationSlug,
                      conversationId,
                      member.userId,
                      member.role === 'admin' ? 'member' : 'admin',
                    ),
                  )
                }
              >
                {member.role === 'admin'
                  ? tOr('ChatGroups.dismissAdmin', 'Dismiss as admin')
                  : tOr('ChatGroups.makeAdmin', 'Make admin')}
              </button>
            ) : null}
            {admin && member.role !== 'admin' ? (
              <button
                type="button"
                className="tm-chatgroup__btn tm-chatgroup__btn--quiet"
                onClick={() =>
                  change.mutate(() =>
                    removeGroupMember(api, organizationSlug, conversationId, member.userId),
                  )
                }
              >
                {tOr('ChatGroups.remove', 'Remove')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {admin ? (
        adding ? (
          <div className="tm-chatgroup-add">
            <input
              className="tm-chatgroup__input"
              value={search}
              placeholder={tOr('ChatGroups.searchPeople', 'Search people')}
              aria-label={tOr('ChatGroups.searchPeople', 'Search people')}
              onChange={(event) => setSearch(event.target.value)}
            />
            <ul className="tm-chatgroup-members">
              {candidates.map((person) => (
                <li key={person.userId} className="tm-chatgroup-member">
                  <span className="tm-chatgroup-member__name">{person.displayName}</span>
                  {person.role.startsWith('client') ? (
                    <span className="tm-chatgroup__chip tm-chatgroup__chip--client">
                      {tOr('ChatGroups.client', 'Client')}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="tm-chatgroup__btn"
                    onClick={() =>
                      change.mutate(() =>
                        addGroupMember(api, organizationSlug, conversationId, person.userId),
                      )
                    }
                  >
                    {tOr('ChatGroups.add', 'Add')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <button type="button" className="tm-chatgroup__btn" onClick={() => setAdding(true)}>
            {tOr('ChatGroups.addMembers', 'Add members')}
          </button>
        )
      ) : null}

      {change.isError ? (
        <p className="tm-chatgroup__error" role="alert">
          {tOr('ChatGroups.changeError', 'That change could not be saved.')}
        </p>
      ) : null}

      <button
        type="button"
        className="tm-chatgroup__btn tm-chatgroup__btn--wide"
        disabled={leave.isPending}
        onClick={() => leave.mutate()}
      >
        {tOr('ChatGroups.leave', 'Leave group')}
      </button>
    </aside>
  );
}
