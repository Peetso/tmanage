'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import {
  ChangeRoleDialog,
  fill,
  firstNameOf,
  initialsOf,
  useRoleChipLabel,
} from '../people/ChangeRoleDialog';
import type { ChangeRoleTarget } from '../people/ChangeRoleDialog';
import { InviteMemberDialog } from '../people/InviteMemberDialog';
import { MemberPasswordResetDialog } from '../people/MemberPasswordResetDialog';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPeople } from '../../lib/api/people';
import type { PersonSummary } from '../../lib/api/people';
import { fetchPendingInvitations } from '../../lib/api/admin-invitations';
import type { ApiClient } from '../../lib/api/client';
import { useOrganizationName, useOrganizationRole } from '../../lib/use-organization-names';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { describePeopleError } from './peopleShared';
import '../../styles/screens/people.css';

export interface PeopleDirectoryScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * The roster row as this screen reads it. `email`, `lastActiveAt` and `version` are drawn when the
 * directory read carries them (r-people's second line, LAST ACTIVE, the role change's
 * compare-and-swap token); an API that omits them shows no address, "—", and a PATCH without a
 * version.
 */
type MemberRow = PersonSummary & {
  readonly email?: string | null;
  readonly lastActiveAt?: string | null;
  readonly version?: number;
};

/** Owner and org admin assign roles and invite (`12-PERMISSION-MATRIX` §2 "Assign roles"). */
const ROLE_ASSIGNERS = new Set(['owner', 'org_admin']);

const PLURAL_EN: Record<string, { one: string; other: string }> = {
  members: { one: '1 member', other: '{count} members' },
  invitations: { one: '1 invitation waiting', other: '{count} invitations waiting' },
  projects: { one: '1 project', other: '{count} projects' },
};

/** A count in the active locale's plural form — Arabic has six, English two. */
function usePlural(): (kind: 'members' | 'invitations' | 'projects', count: number) => string {
  const tr = useTOr();
  const locale = useActiveLocale();
  return (kind, count) => {
    const category = new Intl.PluralRules(locale).select(count);
    const english = PLURAL_EN[kind] ?? { one: '{count}', other: '{count}' };
    const fallback = category === 'one' ? english.one : english.other;
    return fill(tr(`PeopleDirectoryScreen.${kind}.${category}`, fallback), {
      count: count.toLocaleString(locale),
    });
  };
}

/** "Online now"-style wording for LAST ACTIVE, in the active locale; "—" when unknown. */
function useLastActive(): (iso: string | null | undefined) => string {
  const tr = useTOr();
  const locale = useActiveLocale();
  return (iso) => {
    const at = iso ? Date.parse(iso) : Number.NaN;
    if (Number.isNaN(at)) return tr('PeopleDirectoryScreen.lastActiveUnknown', '—');
    const minutes = Math.round((at - Date.now()) / 60_000);
    const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return format.format(hours, 'hour');
    const days = Math.round(hours / 24);
    if (Math.abs(days) < 7) return format.format(days, 'day');
    return format.format(Math.round(days / 7), 'week');
  };
}

type Dialog =
  | { readonly kind: 'role'; readonly target: ChangeRoleTarget }
  | { readonly kind: 'reset'; readonly person: MemberRow }
  | { readonly kind: 'invite' };

/**
 * **Members and roles** — Control Center › People (Figma 374:1985, r-people; A1).
 *
 * The PEOPLE eyebrow, "Members and roles", "N members · M invitations waiting", the black
 * "Invite member", and the roster as a table: NAME (initials, name, address), ROLE (a chip that
 * opens Change role for an owner or admin), PROJECTS, LAST ACTIVE and a row menu — Change role,
 * Send password reset link, View profile, and the red "Remove from <organization>" that opens
 * offboarding. The footnote says the one rule the menu enforces: only an owner changes an owner's
 * role. The screen draws its own header (the frame's), so the shell's is hidden.
 */
export function PeopleDirectoryScreen({
  organizationSlug,
  organizationName,
  client,
}: PeopleDirectoryScreenProps) {
  const api = client ?? browserApiClient();
  const tr = useTOr();
  const plural = usePlural();
  const queryClient = useQueryClient();
  const workspace = useOrganizationName(organizationSlug, organizationName) || organizationName;
  const { role: myRole } = useOrganizationRole(organizationSlug);
  const canAssign = myRole !== undefined && ROLE_ASSIGNERS.has(myRole);
  const iAmOwner = myRole === 'owner';
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const chip = useRoleChipLabel();

  const people = useQuery({
    queryKey: ['people-directory', organizationSlug, ''],
    queryFn: () => listPeople(api, organizationSlug, {}),
  });

  const invitations = useQuery({
    queryKey: ['admin-invitations', organizationSlug],
    queryFn: () => fetchPendingInvitations(api, organizationSlug),
    enabled: canAssign,
    retry: false,
  });

  const roster: readonly MemberRow[] = people.isSuccess ? people.data.people : [];
  const complete = people.isSuccess && people.data.nextAfter === null;
  const activeOwners = roster.filter((person) => person.role === 'owner').length;
  const waiting = Array.isArray(invitations.data?.invitations)
    ? invitations.data.invitations.filter((invitation) => !invitation.isExpired).length
    : null;

  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: ['people-directory', organizationSlug] });
    void queryClient.invalidateQueries({ queryKey: ['admin-invitations', organizationSlug] });
  };

  const summary = people.isSuccess
    ? [
        plural('members', roster.length),
        ...(waiting !== null ? [plural('invitations', waiting)] : []),
      ].join(' · ')
    : null;

  const title = tr('PeopleDirectoryScreen.membersTitle', 'Members and roles');

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="members"
      crumbs={[title]}
      title={title}
      client={api}
    >
      <div className="ppl-screen ppl-screen--own-header">
        <header className="ppl-members-header">
          <div>
            <p className="ppl-mono ppl-members-header__eyebrow">
              {tr('PeopleDirectoryScreen.membersEyebrow', 'People')}
            </p>
            <h1 className="ppl-members-header__title">{title}</h1>
            {summary ? <p className="ppl-members-header__summary">{summary}</p> : null}
          </div>
          {canAssign ? (
            <button
              type="button"
              className="tm-button tm-button--ink ppl-members-header__cta"
              onClick={() => setDialog({ kind: 'invite' })}
            >
              {tr('PeopleDirectoryScreen.inviteMember', 'Invite member')}
            </button>
          ) : null}
        </header>

        <p className="tm-visually-hidden" role="status" aria-live="polite">
          {announcement}
        </p>

        {people.isPending ? (
          <LoadingRegion
            label={tr('PeopleDirectoryScreen.loadingMembers', 'Loading members')}
            className="tm-stack tm-stack--tight ppl-members-loading"
          >
            <Skeleton height="68px" />
            <Skeleton height="68px" />
          </LoadingRegion>
        ) : null}

        {people.isError ? (
          <InlineAlert
            tone="danger"
            title={tr('PeopleDirectoryScreen.membersLoadError', 'Members could not be loaded')}
            live
          >
            {describePeopleError(people.error)}
          </InlineAlert>
        ) : null}

        {people.isSuccess ? (
          <div className="ppl-members-card">
            <table
              className="ppl-members"
              aria-label={tr('PeopleDirectoryScreen.listLabel', 'People in this organization')}
            >
              <thead>
                <tr>
                  <th scope="col">{tr('PeopleDirectoryScreen.membersColName', 'Name')}</th>
                  <th scope="col">{tr('PeopleDirectoryScreen.membersColRole', 'Role')}</th>
                  <th scope="col">{tr('PeopleDirectoryScreen.membersColProjects', 'Projects')}</th>
                  <th scope="col">
                    {tr('PeopleDirectoryScreen.membersColLastActive', 'Last active')}
                  </th>
                  <th scope="col">
                    <span className="tm-visually-hidden">
                      {tr('PeopleDirectoryScreen.membersColActions', 'Actions')}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {roster.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="ppl-members__empty">
                      {tr('PeopleDirectoryScreen.noMembers', 'No members yet.')}
                    </td>
                  </tr>
                ) : (
                  roster.map((person) => {
                    // Only an owner changes an owner's seat (the API's CQ-06 rule, drawn here).
                    const mayChange = canAssign && (person.role !== 'owner' || iAmOwner);
                    return (
                      <MemberRowView
                        key={person.userId}
                        person={person}
                        organizationSlug={organizationSlug}
                        organizationName={workspace}
                        mayChangeRole={mayChange}
                        mayManage={canAssign}
                        chipLabel={chip(person.role)}
                        projectsLabel={plural('projects', person.projectCount)}
                        onChangeRole={() =>
                          setDialog({
                            kind: 'role',
                            target: {
                              userId: person.userId,
                              displayName: person.displayName,
                              role: person.role,
                              ...(typeof person.version === 'number'
                                ? { version: person.version }
                                : {}),
                            },
                          })
                        }
                        onSendReset={() => setDialog({ kind: 'reset', person })}
                      />
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        ) : null}

        {people.isSuccess && !complete ? (
          <p className="ppl-members-footnote">
            {tr(
              'PeopleDirectoryScreen.moreMembers',
              'There are more members than this list shows.',
            )}
          </p>
        ) : null}

        <p className="ppl-members-footnote">
          {tr(
            'PeopleDirectoryScreen.ownerFootnote',
            "Only an owner can change another owner's role.",
          )}
        </p>
      </div>

      {dialog?.kind === 'role' ? (
        <ChangeRoleDialog
          api={api}
          organizationSlug={organizationSlug}
          organizationName={workspace}
          target={dialog.target}
          isOnlyOwner={complete && activeOwners === 1}
          onStale={reload}
          onClose={(changed) => {
            setDialog(null);
            if (changed?.changed) {
              setAnnouncement(
                fill(tr('PeopleDirectoryScreen.roleChanged', '{name} is now {role}.'), {
                  name: dialog.target.displayName,
                  role: chip(changed.role),
                }),
              );
              reload();
            }
          }}
        />
      ) : null}

      {dialog?.kind === 'reset' ? (
        <MemberPasswordResetDialog
          api={api}
          organizationSlug={organizationSlug}
          membershipId={dialog.person.membershipId}
          displayName={dialog.person.displayName}
          firstName={firstNameOf(dialog.person.displayName)}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {dialog?.kind === 'invite' ? (
        <InviteMemberDialog
          api={api}
          organizationSlug={organizationSlug}
          organizationName={workspace}
          onClose={(issued) => {
            setDialog(null);
            if (issued) {
              setAnnouncement(
                fill(tr('PeopleDirectoryScreen.inviteSent', 'Invitation sent to {email}.'), {
                  email: issued.invitation.email,
                }),
              );
              reload();
            }
          }}
        />
      ) : null}
    </ControlCenterShell>
  );
}

function MemberRowView({
  person,
  organizationSlug,
  organizationName,
  mayChangeRole,
  mayManage,
  chipLabel,
  projectsLabel,
  onChangeRole,
  onSendReset,
}: {
  person: MemberRow;
  organizationSlug: string;
  organizationName: string;
  mayChangeRole: boolean;
  mayManage: boolean;
  chipLabel: string;
  projectsLabel: string;
  onChangeRole: () => void;
  onSendReset: () => void;
}) {
  const tr = useTOr();
  const lastActive = useLastActive();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const profileHref = person.membershipId
    ? `/${organizationSlug}/people/${encodeURIComponent(person.membershipId)}`
    : null;

  return (
    <tr className="ppl-member">
      <td>
        <span className="ppl-member__who">
          <span className="ppl-avatar ppl-avatar--40" aria-hidden="true">
            {initialsOf(person.displayName)}
          </span>
          <span>
            <span className="ppl-member__name">{person.displayName}</span>
            {person.email ? (
              <span className="ppl-member__email" dir="ltr">
                {person.email}
              </span>
            ) : null}
          </span>
        </span>
      </td>
      <td>
        {mayChangeRole ? (
          <button
            type="button"
            className="ppl-role-chip"
            aria-label={fill(
              tr('PeopleDirectoryScreen.roleChip', 'Role of {name}: {role}. Change role'),
              { name: person.displayName, role: chipLabel },
            )}
            onClick={onChangeRole}
          >
            {chipLabel}
            <span className="ppl-role-chip__caret" aria-hidden="true" />
          </button>
        ) : (
          <span className="ppl-role-chip ppl-role-chip--static">{chipLabel}</span>
        )}
      </td>
      <td className="ppl-member__cell">{projectsLabel}</td>
      <td className="ppl-member__cell">{lastActive(person.lastActiveAt)}</td>
      <td className="ppl-member__actions">
        <button
          ref={triggerRef}
          type="button"
          className="ppl-kebab"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={fill(tr('PeopleDirectoryScreen.rowActions', 'Actions for {name}'), {
            name: person.displayName,
          })}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true">•••</span>
        </button>
        {open ? (
          <ul ref={menuRef} id={menuId} role="menu" className="ppl-row-menu">
            {mayChangeRole ? (
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="ppl-row-menu__item"
                  onClick={() => {
                    setOpen(false);
                    onChangeRole();
                  }}
                >
                  {tr('PeopleDirectoryScreen.menuChangeRole', 'Change role')}
                </button>
              </li>
            ) : null}
            {mayManage && person.membershipId ? (
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="ppl-row-menu__item"
                  onClick={() => {
                    setOpen(false);
                    onSendReset();
                  }}
                >
                  {tr('PeopleDirectoryScreen.menuSendReset', 'Send password reset link')}
                </button>
              </li>
            ) : null}
            {profileHref ? (
              <li role="none">
                <Link role="menuitem" className="ppl-row-menu__item" href={profileHref}>
                  {tr('PeopleDirectoryScreen.menuViewProfile', 'View profile')}
                </Link>
              </li>
            ) : null}
            {mayChangeRole ? (
              <li role="none">
                <Link
                  role="menuitem"
                  className="ppl-row-menu__item ppl-row-menu__item--danger"
                  href={`/${organizationSlug}/people/offboarding?member=${encodeURIComponent(person.userId)}`}
                >
                  {fill(tr('PeopleDirectoryScreen.menuRemove', 'Remove from {org}'), {
                    org: organizationName,
                  })}
                </Link>
              </li>
            ) : null}
          </ul>
        ) : null}
      </td>
    </tr>
  );
}
