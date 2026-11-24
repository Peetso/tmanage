'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { InfoButton } from '@tmanage/ui';
import type { PersonSummary } from '../../lib/api/people';
import type { AiEmployeeView } from '../../lib/api/ai-employees';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { withNumerals } from '../../lib/i18n/display-format';
import { fill, initialsOf } from '../people/ChangeRoleDialog';
import { PersonAvatar } from '../people/PersonAvatar';
import { AiAvatar, AiBadge, aiInitialsOf } from './AiBadge';
import { AiStatus, useStatusWord } from './AiStatus';
import { RowMenu, type RowMenuItem } from './RowMenu';
import { aiRowStatus, firstWord, personJobTitle, type DirectoryRow } from './ai-employee-model';

export interface RosterActions {
  readonly mayChangeRole: (person: PersonSummary) => boolean;
  readonly mayRemove: (person: PersonSummary) => boolean;
  readonly mayManage: (person: PersonSummary) => boolean;
  /** The role's name in the reader's language (a custom role by its own name). */
  readonly roleLabel: (role: string, roleName?: string | null) => string;
  readonly onChangeRole: (person: PersonSummary) => void;
  readonly onSendReset: (person: PersonSummary) => void;
  readonly onAiStep: (ai: AiEmployeeView, step: 'pause' | 'resume') => void;
}

/**
 * S1, the roster: a table on a desktop (Name · Job title · Role · Sponsor · Status · ⋯) and a list
 * on a phone (name, job title · sponsor, status), as Figma `949:1022` / `949:1853` draw them.
 * People and AI employees share one row shape; an AI employee carries the AI avatar and mark, his
 * sponsor, and "Not connected" while no agent works as him. A retired one is dimmed (S1c).
 */
export function PeopleRoster({
  rows,
  organizationSlug,
  organizationName,
  actions,
  empty,
}: {
  readonly rows: readonly DirectoryRow[];
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly actions: RosterActions;
  /** What the table says when the tab or the search has no row. */
  readonly empty: ReactNode;
}) {
  const tOr = useTOr();
  return (
    <>
      <div className="tm-aie-roster">
        <table
          className="tm-aie-roster__table"
          aria-label={tOr('PeopleDirectoryScreen.listLabel', 'People in this organization')}
        >
          <thead>
            <tr>
              <th scope="col">{tOr('PeopleDirectoryScreen.membersColName', 'Name')}</th>
              <th scope="col">{tOr('AiPeople.colJobTitle', 'Job title')}</th>
              <th scope="col">
                <span className="tm-aie-roster__head">
                  {tOr('PeopleDirectoryScreen.membersColRole', 'Role')}
                  <InfoButton
                    title={tOr('PeopleDirectoryScreen.membersColRole', 'Role')}
                    label={tOr('AiPeople.aboutRole', 'About roles')}
                  >
                    {tOr(
                      'PeopleDirectoryScreen.ownerFootnote',
                      "Only an owner can change another owner's role.",
                    )}
                  </InfoButton>
                </span>
              </th>
              <th scope="col">{tOr('AiPeople.colSponsor', 'Sponsor')}</th>
              <th scope="col">{tOr('AiPeople.colStatus', 'Status')}</th>
              <th scope="col">
                <span className="tm-visually-hidden">
                  {tOr('PeopleDirectoryScreen.membersColActions', 'Actions')}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="tm-aie-roster__empty">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((row) =>
                row.kind === 'person' ? (
                  <PersonRow
                    key={row.key}
                    person={row.person}
                    organizationSlug={organizationSlug}
                    organizationName={organizationName}
                    actions={actions}
                  />
                ) : (
                  <AiRow
                    key={row.key}
                    ai={row.ai}
                    organizationSlug={organizationSlug}
                    actions={actions}
                  />
                ),
              )
            )}
          </tbody>
        </table>
      </div>
      <PhoneRoster rows={rows} organizationSlug={organizationSlug} empty={empty} />
    </>
  );
}

function profileHref(organizationSlug: string, membershipId: string): string {
  return `/${organizationSlug}/people/${encodeURIComponent(membershipId)}`;
}

function PersonFace({
  person,
  organizationSlug,
}: {
  person: PersonSummary;
  organizationSlug: string;
}) {
  return (
    <PersonAvatar
      organizationSlug={organizationSlug}
      userId={person.userId}
      name={person.displayName}
      className="tm-aie-face"
      decorative
      fallback={
        <span className="tm-aie-face" aria-hidden="true">
          {initialsOf(person.displayName)}
        </span>
      }
    />
  );
}

function PersonRow({
  person,
  organizationSlug,
  organizationName,
  actions,
}: {
  person: PersonSummary;
  organizationSlug: string;
  organizationName: string;
  actions: RosterActions;
}) {
  const tOr = useTOr();
  const mayChange = actions.mayChangeRole(person);
  const chipLabel = actions.roleLabel(person.role, person.roleName);
  const href = person.membershipId ? profileHref(organizationSlug, person.membershipId) : null;
  const items: RowMenuItem[] = [];
  if (mayChange) {
    items.push({
      key: 'role',
      label: tOr('PeopleDirectoryScreen.menuChangeRole', 'Change role'),
      onSelect: () => actions.onChangeRole(person),
    });
  }
  if (actions.mayManage(person) && person.membershipId) {
    items.push({
      key: 'reset',
      label: tOr('PeopleDirectoryScreen.menuSendReset', 'Send password reset link'),
      onSelect: () => actions.onSendReset(person),
    });
  }
  if (href) {
    items.push({
      key: 'profile',
      label: tOr('PeopleDirectoryScreen.menuViewProfile', 'View profile'),
      href,
    });
  }
  if (actions.mayRemove(person)) {
    items.push({
      key: 'remove',
      label: fill(tOr('PeopleDirectoryScreen.menuRemove', 'Remove from {org}'), {
        org: organizationName,
      }),
      href: `/${organizationSlug}/people/offboarding?member=${encodeURIComponent(person.userId)}`,
      danger: true,
    });
  }
  const jobTitle = personJobTitle(person);
  return (
    <tr className="tm-aie-roster__row">
      <td>
        <span className="tm-aie-who">
          <PersonFace person={person} organizationSlug={organizationSlug} />
          <span className="tm-aie-who__text">
            <bdi className="tm-aie-who__name">{person.displayName}</bdi>
            {person.email ? (
              <span className="tm-visually-hidden" dir="ltr">
                {person.email}
              </span>
            ) : null}
          </span>
        </span>
      </td>
      <td className="tm-aie-roster__muted">{jobTitle ?? '—'}</td>
      <td>
        {mayChange ? (
          <button
            type="button"
            className="tm-aie-role"
            aria-label={fill(
              tOr('PeopleDirectoryScreen.roleChip', 'Role of {name}: {role}. Change role'),
              { name: person.displayName, role: chipLabel },
            )}
            onClick={() => actions.onChangeRole(person)}
          >
            {chipLabel}
          </button>
        ) : (
          <span className="tm-aie-roster__muted">{chipLabel}</span>
        )}
      </td>
      <td className="tm-aie-roster__muted">—</td>
      <td>
        <AiStatus status="active" />
      </td>
      <td className="tm-aie-roster__end">
        <RowMenu
          label={fill(tOr('PeopleDirectoryScreen.rowActions', 'Actions for {name}'), {
            name: person.displayName,
          })}
          items={items}
        />
      </td>
    </tr>
  );
}

function SponsorCell({ ai }: { ai: AiEmployeeView }) {
  const name = ai.sponsor.displayName;
  if (name === null) return <span className="tm-aie-roster__muted">—</span>;
  return (
    <span className="tm-aie-who">
      <span className="tm-aie-face" aria-hidden="true">
        {initialsOf(name)}
      </span>
      <bdi>{name}</bdi>
    </span>
  );
}

/** "Retired on 24 Nov" (S1c's second line). */
function useRetiredLine(): (ai: AiEmployeeView) => string {
  const tOr = useTOr();
  const locale = useActiveLocale();
  return (ai) => {
    const at = ai.retiredAt === null ? Number.NaN : Date.parse(ai.retiredAt);
    if (Number.isNaN(at)) return tOr('AiPeople.status.retired', 'Retired');
    const day = new Intl.DateTimeFormat(withNumerals(locale), {
      day: 'numeric',
      month: 'short',
    }).format(at);
    return fill(tOr('AiPeople.retiredOn', 'Retired on {date}'), { date: day });
  };
}

function AiRow({
  ai,
  organizationSlug,
  actions,
}: {
  ai: AiEmployeeView;
  organizationSlug: string;
  actions: RosterActions;
}) {
  const tOr = useTOr();
  const status = aiRowStatus(ai);
  const href = profileHref(organizationSlug, ai.membershipId);
  const items: RowMenuItem[] = [
    { key: 'profile', label: tOr('PeopleDirectoryScreen.menuViewProfile', 'View profile'), href },
  ];
  if (ai.canPause && ai.status === 'active') {
    items.push({
      key: 'pause',
      label: tOr('AiProfile.pause', 'Pause'),
      onSelect: () => actions.onAiStep(ai, 'pause'),
    });
  }
  if (ai.canResume && ai.status === 'paused') {
    items.push({
      key: 'resume',
      label: tOr('AiProfile.resume', 'Resume'),
      onSelect: () => actions.onAiStep(ai, 'resume'),
    });
  }
  return (
    <tr className="tm-aie-roster__row" data-retired={status === 'retired' || undefined}>
      <td>
        <span className="tm-aie-who">
          <AiAvatar initials={aiInitialsOf(ai.displayName)} className="tm-aie-dim" />
          <Link href={href} className="tm-aie-who__name tm-aie-dim">
            <bdi>{ai.displayName}</bdi>
          </Link>
          <AiBadge className="tm-aie-dim" />
        </span>
      </td>
      <td className="tm-aie-roster__muted">{ai.jobTitle}</td>
      <td className="tm-aie-roster__muted">{actions.roleLabel(ai.role)}</td>
      <td>
        <SponsorCell ai={ai} />
      </td>
      <td>
        <AiStatus status={status} />
      </td>
      <td className="tm-aie-roster__end">
        <RowMenu
          label={fill(tOr('PeopleDirectoryScreen.rowActions', 'Actions for {name}'), {
            name: ai.displayName,
          })}
          items={items}
        />
      </td>
    </tr>
  );
}

/** The phone list (Figma `949:1853`): each row opens the profile; status at the end. */
function PhoneRoster({
  rows,
  organizationSlug,
  empty,
}: {
  rows: readonly DirectoryRow[];
  organizationSlug: string;
  empty: ReactNode;
}) {
  const tOr = useTOr();
  const word = useStatusWord();
  const retiredLine = useRetiredLine();
  if (rows.length === 0) return <p className="tm-aie-phone-list tm-aie-roster__empty">{empty}</p>;
  return (
    <ul
      className="tm-aie-phone-list"
      aria-label={tOr('PeopleDirectoryScreen.listLabel', 'People in this organization')}
    >
      {rows.map((row) => {
        if (row.kind === 'person') {
          const person = row.person;
          const href = person.membershipId
            ? profileHref(organizationSlug, person.membershipId)
            : null;
          const name = <bdi className="tm-aie-who__name">{person.displayName}</bdi>;
          return (
            <li key={row.key} className="tm-aie-phone-row">
              <PersonFace person={person} organizationSlug={organizationSlug} />
              <span className="tm-aie-phone-row__text">
                {href ? <Link href={href}>{name}</Link> : name}
                <span className="tm-aie-phone-row__sub">{personJobTitle(person) ?? ''}</span>
              </span>
              <AiStatus status="active" />
            </li>
          );
        }
        const ai = row.ai;
        const status = aiRowStatus(ai);
        const sponsor = firstWord(ai.sponsor.displayName);
        const sub =
          status === 'retired'
            ? retiredLine(ai)
            : sponsor === ''
              ? ai.jobTitle
              : `${ai.jobTitle} · ${fill(tOr('AiPeople.sponsorShort', 'Sponsor: {name}'), { name: sponsor })}`;
        return (
          <li
            key={row.key}
            className="tm-aie-phone-row"
            data-retired={status === 'retired' || undefined}
          >
            <AiAvatar initials={aiInitialsOf(ai.displayName)} className="tm-aie-dim" />
            <span className="tm-aie-phone-row__text">
              <span className="tm-aie-who">
                <Link href={profileHref(organizationSlug, ai.membershipId)} className="tm-aie-dim">
                  <bdi className="tm-aie-who__name">{ai.displayName}</bdi>
                </Link>
                <AiBadge className="tm-aie-dim" />
              </span>
              <span className="tm-aie-phone-row__sub">{sub}</span>
            </span>
            {status === 'retired' ? (
              <span className="tm-visually-hidden">{word(status)}</span>
            ) : (
              <AiStatus status={status} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
