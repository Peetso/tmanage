'use client';

import { useMemo, useState } from 'react';
import { Avatar, Badge, Button, Field, InlineAlert, StateCapsule } from '@tmanage/ui';
import { OnboardingShell } from '../shell/OnboardingShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { issueInvitation } from '../../lib/api/invitations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { describeInternalRole, INVITABLE_ROLES } from '../../lib/roles';
import {
  checkInvites,
  describeInviteProblem,
  isPlausibleEmail,
  type InviteCandidate,
} from '../../lib/invitations';
import type { ApiClient } from '../../lib/api/client';
import { useHydrated } from '../../lib/use-hydrated';

export interface InviteTeamScreenProps {
  signedInAs: string;
  /** The organization the invitations are into. From the route, which the guard resolves. */
  organizationSlug: string;
  /** The organization's own mail domain, used to spot client addresses. */
  organizationDomain: string;
  /** Addresses that already hold a membership, so duplicates are caught before sending. */
  existingMembers: readonly string[];
  client?: ApiClient;
}

/** One address after the API has answered for it. */
interface Sent {
  readonly email: string;
  readonly role: string;
  readonly outcome: 'sent' | 'failed';
  /** The invitation link, for the ones that worked. Shown once and never fetchable again. */
  readonly link?: string;
  /** What the server did about email — `IssuedInvitation.delivery`, absent on a failure. */
  readonly delivery?: 'sent' | 'none' | 'failed';
  readonly problem?: string;
}

/**
 * **ON-04 Invite internal team.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Email list, role, project access; preview each role; invalid
 * domains and duplicates inline."
 *
 * Real as of `TEN-003`. Every check still runs in the browser as the address is added —
 * `lib/invitations.ts` carries the reasoning — and the addresses that survive them are now
 * actually sent.
 *
 * ## The roles it offers are the roles that exist
 *
 * This screen shipped with `admin`, `member` and `viewer`, and **two of those were not roles
 * this system has**. Nothing caught it because nothing was sent. `INVITABLE_ROLES` in
 * `lib/roles.ts` is keyed by the domain's own `InternalRole`, so the list cannot drift again
 * without a type error.
 *
 * ## Whether the invitation was emailed is the server's answer, not this screen's guess
 *
 * Since the mailer slice, `issueInvitation` returns `delivery` beside the token: `'sent'`
 * when an SMTP server accepted a message carrying the same link, `'none'` when no transport
 * is configured (the bootstrap default, `EMAIL_DRIVER=console`), `'failed'` when one exists
 * and refused. The link is rendered once for every successful invitation regardless — the
 * row holds only a hash, so nothing can produce it again — and each result says whether the
 * email happened, because "invitations sent" on a `'none'` answer would be describing a
 * delivery that did not.
 *
 * ## One request per address
 *
 * Not one request for the list. Each address succeeds or fails on its own — a duplicate is a
 * 409 and the rest should still go — and the result list says which did which. A batch endpoint
 * would have to invent a partial-success shape that the API does not have.
 */
export function InviteTeamScreen({
  signedInAs,
  organizationSlug,
  organizationDomain,
  existingMembers,
  client,
}: InviteTeamScreenProps) {
  const api = client ?? browserApiClient();

  // The add-an-address form has no query behind it, so it gates on the hydration signal: the
  // draft email input ships disabled in the server HTML and becomes editable only once React is
  // live, so an address typed on a cold page is not silently wiped by hydration.
  const hydrated = useHydrated();

  const [draftEmail, setDraftEmail] = useState('');
  const [draftRole, setDraftRole] = useState<string>(INVITABLE_ROLES[0] ?? 'member');
  const [candidates, setCandidates] = useState<readonly InviteCandidate[]>([]);
  const [draftError, setDraftError] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<readonly Sent[]>([]);

  const checked = useMemo(
    () => checkInvites({ candidates, organizationDomain, existingMembers }),
    [candidates, organizationDomain, existingMembers],
  );

  const sendable = checked.filter((invite) => invite.sendable);
  const role = describeInternalRole(draftRole);

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

  async function send() {
    setSending(true);
    const outcomes: Sent[] = [];

    // Sequential rather than parallel. These are writes into one organization, the list is
    // short, and a failure part-way through leaves a result list a person can read rather
    // than a race whose order they cannot explain.
    for (const invite of sendable) {
      try {
        const issued = await issueInvitation(api, organizationSlug, {
          email: invite.email,
          role: invite.role,
        });
        outcomes.push({
          email: invite.email,
          role: invite.role,
          outcome: 'sent',
          link: `${window.location.origin}/invitations/${issued.token}`,
          delivery: issued.delivery,
        });
      } catch (error) {
        outcomes.push({
          email: invite.email,
          role: invite.role,
          outcome: 'failed',
          problem:
            error instanceof ApiRequestError
              ? error.message
              : error instanceof NetworkError
                ? 'The API did not answer. Is it running?'
                : 'Something went wrong.',
        });
      }
    }

    // Only the ones that failed stay in the list, so a retry does not re-send the rest.
    setCandidates((current) =>
      current.filter((candidate) =>
        outcomes.some(
          (outcome) => outcome.email === candidate.email && outcome.outcome === 'failed',
        ),
      ),
    );
    setResults((current) => [...current, ...outcomes]);
    setSending(false);
  }

  return (
    <OnboardingShell
      current="ON-04"
      signedInAs={signedInAs}
      title="Invite your team"
      description="Only the people who work on delivery. Clients are invited separately, as a client organization with its own portal."
    >
      <p className="tm-prose">
        Invitations are created for real. Whether each one is also emailed depends on this
        deployment’s mail settings — the result below says what happened. Either way the link is
        shown below, once. There is no way to see it again — the invitation stores only a hash of
        its token.
      </p>

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
        <fieldset className="tm-fieldset tm-stack" disabled={!hydrated}>
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
              {INVITABLE_ROLES.map((option) => (
                <option key={option} value={option}>
                  {describeInternalRole(option).label}
                </option>
              ))}
            </select>
          </div>

          <div className="tm-row">
            <Button type="submit" tone="outline">
              Add to the list
            </Button>
          </div>
        </fieldset>
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
                  <Badge>{describeInternalRole(invite.role).label}</Badge>
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

      {results.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-invite-results">
          <h2 id="tm-invite-results" className="tm-eyebrow">
            Links to send
          </h2>
          <ul className="tm-stack tm-stack--tight tm-list">
            {results.map((result, index) => (
              <li key={`${result.email}-${index}`} className="tm-stack tm-stack--tight">
                <div className="tm-row">
                  <StateCapsule state={result.outcome === 'sent' ? 'done' : 'blocked'}>
                    {result.outcome === 'sent' ? 'Created' : 'Not created'}
                  </StateCapsule>
                  <span className="tm-mono">{result.email}</span>
                </div>
                {result.link ? (
                  <>
                    <p className="tm-prose tm-mono tm-break">{result.link}</p>
                    <p className="tm-prose">
                      {result.delivery === 'sent'
                        ? `Also emailed to ${result.email}.`
                        : result.delivery === 'failed'
                          ? 'The email could not be sent — you have to send it yourself.'
                          : 'Nothing emailed this link — you have to send it yourself.'}
                    </p>
                  </>
                ) : (
                  <p className="tm-prose">{result.problem}</p>
                )}
              </li>
            ))}
          </ul>
          <p className="tm-field__hint">
            Each link works once and expires. Send it to the person it names and to nobody else —
            anyone holding it can join this organization.
          </p>
        </section>
      ) : null}

      <div className="tm-row">
        <Button
          tone="ink"
          size="accessible"
          loading={sending}
          loadingLabel="Creating invitations"
          disabled={sendable.length === 0}
          onClick={() => void send()}
        >
          {sendable.length === 0
            ? 'Create invitations'
            : `Create ${sendable.length} ${sendable.length === 1 ? 'invitation' : 'invitations'}`}
        </Button>
      </div>
    </OnboardingShell>
  );
}
