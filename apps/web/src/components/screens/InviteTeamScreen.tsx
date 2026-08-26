'use client';

import { useMemo, useState } from 'react';
import { Avatar, Badge, Button, Field, InlineAlert } from '@tmanage/ui';
import { OnboardingShell } from '../shell/OnboardingShell';
import { BackendPending } from './BackendPending';
import {
  checkInvites,
  describeInviteProblem,
  isPlausibleEmail,
  type InviteCandidate,
} from '../../lib/invitations';

/**
 * The internal roles this screen can offer, with what each one will actually be able to do.
 *
 * `22-SCREEN-BY-SCREEN` §3 asks ON-04 to "preview each role", and the preview is the
 * important half: a role name is a label, and the person sending the invitation is
 * responsible for what it grants. The sentences are drawn from `12-PERMISSION-MATRIX`.
 *
 * `project_memberships.role` is `varchar(64)` with no constraint — it accepts any string,
 * which is a known gap recorded in `docs/implementation-status.md`. This list is therefore
 * the *only* thing keeping a typo out of that column from this screen, which is a reason to
 * close the database gap rather than a substitute for closing it.
 */
const ROLES = [
  {
    value: 'admin',
    label: 'Admin',
    grants: [
      'Everything a team member can do',
      'Invite people and change their roles',
      'Open the Control Center',
    ],
    withholds: 'Cannot delete the organization.',
  },
  {
    value: 'member',
    label: 'Team member',
    grants: [
      'Every internal project they are assigned to',
      'Chat channels they join, plus project channels',
      'Work, docs and files in their projects',
    ],
    withholds: 'They cannot change roles, publish to clients, or open the Control Center.',
  },
  {
    value: 'viewer',
    label: 'Viewer',
    grants: ['Read-only access to projects they are assigned to'],
    withholds: 'They cannot change anything.',
  },
] as const;

export interface InviteTeamScreenProps {
  signedInAs: string;
  /** The organization's own mail domain, used to spot client addresses. */
  organizationDomain: string;
  /** Addresses that already hold a membership, so duplicates are caught before sending. */
  existingMembers: readonly string[];
}

/**
 * **ON-04 Invite internal team.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Email list, role, project access; preview each role; invalid
 * domains and duplicates inline."
 *
 * Every check runs in the browser as the address is added, and every one of them is honest
 * about its limits — `lib/invitations.ts` carries the reasoning. Nothing is sent: invitations
 * are `TEN-003`, and there is neither a table nor an endpoint for them.
 *
 * The role preview is rendered for the role currently selected, not hidden behind a link. A
 * preview nobody opens is a preview that does not exist, and the whole point of `12-
 * PERMISSION-MATRIX` being visible here is that access is granted deliberately.
 */
export function InviteTeamScreen({
  signedInAs,
  organizationDomain,
  existingMembers,
}: InviteTeamScreenProps) {
  const [draftEmail, setDraftEmail] = useState('');
  const [draftRole, setDraftRole] = useState<string>(ROLES[1].value);
  const [candidates, setCandidates] = useState<readonly InviteCandidate[]>([]);
  const [draftError, setDraftError] = useState<string | undefined>(undefined);

  const checked = useMemo(
    () => checkInvites({ candidates, organizationDomain, existingMembers }),
    [candidates, organizationDomain, existingMembers],
  );

  const sendable = checked.filter((invite) => invite.sendable);
  const role = ROLES.find((candidate) => candidate.value === draftRole) ?? ROLES[1];

  function add() {
    const email = draftEmail.trim();
    if (!isPlausibleEmail(email)) {
      setDraftError('That does not look like an email address.');
      return;
    }
    setCandidates((current) => [...current, { email, role: draftRole }]);
    setDraftEmail('');
    setDraftError(undefined);
  }

  return (
    <OnboardingShell
      current="ON-04"
      signedInAs={signedInAs}
      title="Invite your team"
      description="Only the people who work on delivery. Clients are invited separately, as a client organization with its own portal."
    >
      <BackendPending ticket="TEN-003">
        No invitation is sent or stored. The list below is checked as you build it and then goes
        nowhere.
      </BackendPending>

      {/*
        `noValidate` because this form does its own checking and says so in the design
        system's own error affordance. Without it the browser refuses to submit an
        `input[type="email"]` whose value it dislikes and shows a native bubble instead —
        which cannot be styled, disappears on the next click, is not associated with the
        field for a screen reader, and would mean `checkInvites` never runs on exactly the
        addresses it exists to explain.
      */}
      <form
        className="tm-stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Field
          label="Email address"
          name="email"
          type="email"
          value={draftEmail}
          onChange={(event) => {
            setDraftEmail(event.target.value);
            setDraftError(undefined);
          }}
          dir="ltr"
          autoComplete="off"
          placeholder={`name@${organizationDomain}`}
          {...(draftError === undefined ? {} : { error: draftError })}
        />

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-invite-role">
            Role
          </label>
          <select
            id="tm-invite-role"
            className="tm-field__control"
            value={draftRole}
            onChange={(event) => setDraftRole(event.target.value)}
          >
            {ROLES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="tm-row">
          <Button type="submit" tone="outline">
            Add to the list
          </Button>
        </div>
      </form>

      <section className="tm-panel tm-stack" aria-labelledby="tm-role-preview">
        <h2 id="tm-role-preview" className="tm-eyebrow">
          What a {role.label.toLowerCase()} will see
        </h2>
        <ul className="tm-stack tm-stack--tight tm-list">
          {role.grants.map((grant) => (
            <li key={grant}>{grant}</li>
          ))}
        </ul>
        <p className="tm-prose">
          <strong>{role.withholds}</strong>
        </p>
      </section>

      <section className="tm-stack" aria-labelledby="tm-invite-list">
        <h2 id="tm-invite-list" className="tm-eyebrow">
          {checked.length === 0
            ? 'Nobody added yet'
            : `${checked.length} ${checked.length === 1 ? 'person' : 'people'}`}
        </h2>

        {checked.length === 0 ? (
          <p className="tm-prose">Add an address above. You can also skip this and invite later.</p>
        ) : (
          <ul className="tm-stack tm-stack--tight tm-list">
            {checked.map((invite, index) => (
              <li key={`${invite.email}-${index}`} className="tm-panel tm-stack tm-stack--tight">
                <div className="tm-row">
                  <Avatar name={invite.email} decorative />
                  <span className="tm-mono">{invite.email}</span>
                  <Badge>{ROLES.find((r) => r.value === invite.role)?.label ?? invite.role}</Badge>
                  <span className="tm-push-end">
                    <Button
                      tone="text"
                      size="compact"
                      onClick={() =>
                        setCandidates((current) => current.filter((_, at) => at !== index))
                      }
                    >
                      Remove {invite.email}
                    </Button>
                  </span>
                </div>

                {invite.problems.map((problem) => (
                  <InlineAlert
                    key={problem}
                    tone={problem === 'outside-domain' ? 'client' : 'warning'}
                  >
                    {describeInviteProblem(problem, organizationDomain)}
                  </InlineAlert>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="tm-row">
        <Button tone="ink" size="accessible" disabled>
          {sendable.length === 0
            ? 'Send invitations'
            : `Send ${sendable.length} ${sendable.length === 1 ? 'invitation' : 'invitations'}`}
        </Button>
        <Button tone="text" disabled>
          Skip for now
        </Button>
      </div>
    </OnboardingShell>
  );
}
