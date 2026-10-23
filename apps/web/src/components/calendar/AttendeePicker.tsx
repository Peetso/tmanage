'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listMembers } from '../../lib/api/members';
import type { MemberSummary } from '../../lib/api/members';
import { listClientCandidates } from '../../lib/api/meeting-attendees';
import type { ClientAttendeeCandidateView } from '../../lib/api/meeting-attendees';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { initials } from '../screens/MeetingsScreen';
import '../screens/meeting-detail.css';

export interface AttendeePickerProps {
  api: ApiClient;
  organizationSlug: string;
  /** Shown under each team member ("Northstar Studio"). */
  organizationName: string;
  meetingId: string;
  /** The meeting's project, named in the clients group ("Clients on Atlas relaunch"). */
  projectName: string;
  /** People already on the meeting or already picked — never offered again. */
  excludedUserIds: ReadonlySet<string>;
  onPickMember: (member: MemberSummary) => void;
  onPickClient: (candidate: ClientAttendeeCandidateView) => void;
  onClose: () => void;
}

/**
 * **A5 — "+ Add people" (Figma `mt-edit`).** The popover under a meeting's attendee chips.
 *
 * One search field over two groups: YOUR TEAM — the organization's active members, searched on the
 * server (`listMembers` with `q`, so the roster beyond the first page is reachable) — and CLIENTS ON
 * <PROJECT> — the client people of *this meeting's project* only (`GET .../client-candidates`); a
 * client of another project is never offered, which the hint above the chips says in words.
 * Choosing a person hands them to the screen, which invites them on save; Escape closes.
 */
export function AttendeePicker({
  api,
  organizationSlug,
  organizationName,
  meetingId,
  projectName,
  excludedUserIds,
  onPickMember,
  onPickClient,
  onClose,
}: AttendeePickerProps) {
  const tOr = useTOr();
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Escape closes the popover from anywhere inside or outside it.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const members = useQuery({
    queryKey: ['members', organizationSlug, 'attendee-picker', query.trim()],
    queryFn: () => listMembers(api, organizationSlug, { q: query }),
  });

  const candidates = useQuery({
    queryKey: ['meeting-client-candidates', organizationSlug, meetingId],
    queryFn: () => listClientCandidates(api, organizationSlug, meetingId),
  });

  const needle = query.trim().toLowerCase();
  const team = useMemo(
    () =>
      (members.data?.members ?? []).filter(
        (member) =>
          !excludedUserIds.has(member.userId) &&
          (needle === '' || member.displayName.toLowerCase().includes(needle)),
      ),
    [members.data, excludedUserIds, needle],
  );
  const clients = useMemo(
    () =>
      (candidates.data?.candidates ?? []).filter(
        (candidate) =>
          !excludedUserIds.has(candidate.userId) &&
          (needle === '' || candidate.displayName.toLowerCase().includes(needle)),
      ),
    [candidates.data, excludedUserIds, needle],
  );

  const clientsHeading = tOr('AttendeePicker.clientsOn', 'Clients on {project}').replace(
    '{project}',
    projectName,
  );
  const loading = members.isPending || candidates.isPending;

  return (
    <div
      className="tm-mtd-picker"
      role="dialog"
      aria-label={tOr('AttendeePicker.dialogLabel', 'Add people')}
    >
      <input
        ref={input}
        className="tm-mtd-input tm-mtd-picker__search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label={tOr('AttendeePicker.searchLabel', 'Find people')}
        autoComplete="off"
      />

      <p className="tm-mtd-picker__group" id="tm-mtd-picker-team">
        {tOr('AttendeePicker.yourTeam', 'Your team')}
      </p>
      <ul className="tm-mtd-picker__list" aria-labelledby="tm-mtd-picker-team">
        {team.map((member) => (
          <li key={member.userId}>
            <button
              type="button"
              className="tm-mtd-picker__option"
              onClick={() => onPickMember(member)}
            >
              <span className="tm-mtd-orb tm-mtd-orb--lg" aria-hidden="true">
                {initials(member.displayName)}
              </span>
              <span className="tm-mtd-picker__who">
                <span className="tm-mtd-picker__name">{member.displayName}</span>
                <span className="tm-mtd-picker__sub">{organizationName}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="tm-mtd-picker__group" id="tm-mtd-picker-clients">
        {clientsHeading}
      </p>
      <ul className="tm-mtd-picker__list" aria-labelledby="tm-mtd-picker-clients">
        {clients.map((candidate) => (
          <li key={candidate.userId}>
            <button
              type="button"
              className="tm-mtd-picker__option"
              onClick={() => onPickClient(candidate)}
            >
              <span className="tm-mtd-orb tm-mtd-orb--lg tm-mtd-orb--client" aria-hidden="true">
                {initials(candidate.displayName)}
              </span>
              <span className="tm-mtd-picker__who">
                <span className="tm-mtd-picker__name">{candidate.displayName}</span>
                <span className="tm-mtd-picker__sub">{candidate.clientOrganizationName}</span>
              </span>
              <span className="tm-mtd-tag tm-mtd-tag--client">
                {tOr('AttendeePicker.client', 'Client')}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {!loading && team.length === 0 && clients.length === 0 ? (
        <p className="tm-mtd-picker__empty" role="status">
          {tOr('AttendeePicker.empty', 'No one matches that name.')}
        </p>
      ) : null}
    </div>
  );
}
