'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@tmanage/ui';
import { OnboardingShell } from '../shell/OnboardingShell';
import { OnboardingScreenStyles } from './CreateOrganizationScreen';
import { browserApiClient } from '../../lib/api/browser-client';
import { issueInvitation } from '../../lib/api/invitations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { describeInternalRole, INVITABLE_ROLES } from '../../lib/roles';
import {
  checkInvites,
  describeInviteProblem,
  isPlausibleEmail,
  type InviteCandidate,
  type InviteProblem,
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
    <OnboardingShell current="ON-04" signedInAs={signedInAs} title="Invite your team">
      <OnboardingScreenStyles />
      <style href="tm-onboarding-team" precedence="default">
        {TEAM_CSS}
      </style>
      <p className="tm-ob-lede">
        Only the people who work on delivery. Clients are invited separately, as a client
        organization with its own portal.
      </p>

      <div className="tm-ob-team">
        <div className="tm-ob-sheet tm-ob-sheet--card tm-ob-team__list">
          {/*
            `noValidate` because this form does its own checking and says so in the design
            system's own error affordance. Without it the browser refuses to submit an
            `input[type="email"]` whose value it dislikes and shows a native bubble instead —
            which cannot be styled, disappears on the next click, is not associated with the
            field for a screen reader, and would mean `checkInvites` never runs on exactly the
            addresses it exists to explain.
          */}
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <fieldset className="tm-fieldset tm-ob-team__add" disabled={!hydrated}>
              <legend className="tm-visually-hidden">Add a person</legend>
              <div className="tm-ob-team__email">
                <label className="tm-visually-hidden" htmlFor="tm-invite-email">
                  Email address
                </label>
                <input
                  id="tm-invite-email"
                  className="tm-field__control"
                  name="email"
                  type="email"
                  value={draftEmail}
                  onChange={(event) => {
                    setDraftEmail(event.target.value);
                    setDraftError(undefined);
                  }}
                  dir="ltr"
                  autoComplete="off"
                  placeholder={
                    organizationDomain ? `name@${organizationDomain}` : 'name@company.com'
                  }
                  aria-invalid={draftError === undefined ? undefined : true}
                  aria-describedby={draftError === undefined ? undefined : 'tm-invite-email-error'}
                />
              </div>
              <div className="tm-ob-team__role">
                <label className="tm-visually-hidden" htmlFor="tm-invite-role">
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
              <Button type="submit" tone="ink" size="feature">
                <span aria-hidden="true">Add</span>
                <span className="tm-visually-hidden">Add to the list</span>
              </Button>
            </fieldset>
            {draftError === undefined ? null : (
              <span className="tm-field__error tm-ob-team__error" id="tm-invite-email-error">
                <span className="tm-inline-alert__glyph" aria-hidden="true">
                  !
                </span>
                {draftError}
              </span>
            )}
          </form>

          <section className="tm-ob-team__people" aria-labelledby="tm-invite-list">
            <h2 id="tm-invite-list" className="tm-ob-eyebrow">
              {checked.length === 0
                ? 'Nobody added yet'
                : `${checked.length} ${checked.length === 1 ? 'person' : 'people'}`}
            </h2>

            {checked.length === 0 ? (
              <p className="tm-ob-team__empty">
                Add an address above. You can also skip this and invite later.
              </p>
            ) : (
              <ul className="tm-ob-team__rows">
                {checked.map((invite, index) => {
                  const problem = invite.problems[0];
                  const tone =
                    problem === undefined
                      ? undefined
                      : problem === 'outside-domain'
                        ? 'danger'
                        : 'warning';
                  return (
                    <li
                      key={`${invite.email}-${index}`}
                      className="tm-ob-team__row"
                      data-tone={tone}
                    >
                      {tone === undefined ? (
                        <span className="tm-ob-avatar" aria-hidden="true">
                          {invite.email.slice(0, 2)}
                        </span>
                      ) : (
                        <span className={`tm-ob-glyph tm-ob-glyph--${tone}`} aria-hidden="true">
                          {tone === 'danger' ? '✕' : '!'}
                        </span>
                      )}
                      <span className="tm-ob-team__who">
                        <span className="tm-ob-team__address">
                          {problem === undefined
                            ? invite.email
                            : headlineFor(problem, invite.email)}
                        </span>
                        {invite.problems.map((each) => (
                          <span key={each} className="tm-ob-team__problem">
                            {describeInviteProblem(each, organizationDomain)}
                          </span>
                        ))}
                      </span>
                      <span className="tm-ob-team__badge">
                        {describeInternalRole(invite.role).label}
                      </span>
                      <button
                        type="button"
                        className="tm-ob-team__remove"
                        onClick={() =>
                          setCandidates((current) => current.filter((_, at) => at !== index))
                        }
                      >
                        <span aria-hidden="true">✕</span>
                        <span className="tm-visually-hidden">Remove {invite.email}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {results.length > 0 ? (
            <section className="tm-ob-team__results" aria-labelledby="tm-invite-results">
              <h2 id="tm-invite-results" className="tm-ob-eyebrow">
                Links to send
              </h2>
              <ul className="tm-ob-team__rows">
                {results.map((result, index) => (
                  <li
                    key={`${result.email}-${index}`}
                    className="tm-ob-team__result"
                    data-outcome={result.outcome}
                  >
                    <div className="tm-ob-team__result-head">
                      <span
                        className={`tm-ob-glyph ${
                          result.outcome === 'sent' ? 'tm-ob-glyph--ink' : 'tm-ob-glyph--danger'
                        }`}
                        aria-hidden="true"
                      >
                        {result.outcome === 'sent' ? '✓' : '✕'}
                      </span>
                      <span className="tm-ob-team__address">{result.email}</span>
                      <span className="tm-ob-team__badge">
                        {result.outcome === 'sent' ? 'Created' : 'Not created'}
                      </span>
                    </div>
                    {result.link ? (
                      <>
                        <p className="tm-ob-team__link" data-testid="tm-invitation-link">
                          {result.link}
                        </p>
                        <p className="tm-ob-team__problem">
                          {result.delivery === 'sent'
                            ? `Also emailed to ${result.email}.`
                            : result.delivery === 'failed'
                              ? 'The email could not be sent — you have to send it yourself.'
                              : 'Nothing emailed this link — you have to send it yourself.'}
                        </p>
                      </>
                    ) : (
                      <p className="tm-ob-team__problem">{result.problem}</p>
                    )}
                  </li>
                ))}
              </ul>
              <p className="tm-field__hint">
                Each link works once and expires, and there is no way to see it again — the
                invitation stores only a hash of it. Send it to the person it names and to nobody
                else: anyone holding it can join this organization.
              </p>
            </section>
          ) : null}
        </div>

        <section className="tm-ob-team__night" aria-labelledby="tm-role-preview">
          <h2 id="tm-role-preview" className="tm-ob-eyebrow">
            What a {role.label.toLowerCase()} will see
          </h2>
          <ul className="tm-ob-team__grants">
            {role.grants.map((grant) => (
              <li key={grant}>{grant}</li>
            ))}
          </ul>
          <hr className="tm-ob-team__night-rule" />
          <p className="tm-ob-team__withholds">{role.withholds}</p>
          <p className="tm-ob-team__note">
            Each person gets a one-time link. If this deployment does not send email, the link is
            shown here once, for you to send.
          </p>
          <div className="tm-ob-actions">
            <Button
              tone="lime"
              size="feature"
              className="tm-ob-cta"
              loading={sending}
              loadingLabel="Creating invitations"
              disabled={sendable.length === 0}
              onClick={() => void send()}
            >
              {sendable.length === 0
                ? 'Create invitations'
                : `Create ${sendable.length} ${sendable.length === 1 ? 'invitation' : 'invitations'}`}
            </Button>
            <Link className="tm-ob-team__skip" href={`/${organizationSlug}/home`}>
              Skip for now
            </Link>
          </div>
        </section>
      </div>
    </OnboardingShell>
  );
}

/** The row's own headline when a check stopped it — the export's "… is already a member". */
function headlineFor(problem: InviteProblem, email: string): string {
  switch (problem) {
    case 'already-a-member':
      return `${email} is already a member`;
    case 'outside-domain':
      return `${email} is outside your domain`;
    case 'duplicate-in-list':
      return `${email} is already in the list`;
    default:
      return email;
  }
}

const TEAM_CSS = `
.tm-ob-team { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(300px, 1fr); gap: 18px; align-items: start; }
.tm-ob-team__list { gap: 14px; }
.tm-ob-team__add { display: flex; gap: 10px; align-items: stretch; }
.tm-ob-team__email { flex: 1; min-inline-size: 0; }
.tm-ob-team__add .tm-field__control { inline-size: 100%; min-block-size: 48px; padding-inline: 14px; border-color: var(--line-300); }
.tm-ob-team__email .tm-field__control { background: var(--paper-0); }
.tm-ob-team__email .tm-field__control:focus-visible {
  outline: none; border: var(--b-expressive) solid var(--ink-950); box-shadow: 0 0 0 3px var(--lime-500);
}
.tm-ob-team__role .tm-field__control { font-size: var(--t-ui-sm); font-weight: 500; color: var(--ink-950); }
.tm-ob-team__error { margin-block-start: 8px; }
.tm-ob-team__people, .tm-ob-team__results { display: flex; flex-direction: column; gap: 10px; }
.tm-ob-team__empty { margin: 0; font-size: var(--t-ui-sm); line-height: var(--t-ui-sm-line); color: var(--ink-650); }
.tm-ob-team__rows { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.tm-ob-team__row {
  display: flex; align-items: center; gap: 12px; min-block-size: 48px; padding: 8px 14px;
  border: var(--b-structural) solid transparent; border-radius: var(--r-control); background: var(--paper-50);
}
.tm-ob-team__row[data-tone] { min-block-size: 56px; background: var(--paper-0); }
.tm-ob-team__row[data-tone='warning'] { border-color: var(--warning-600); }
.tm-ob-team__row[data-tone='danger'] { border-color: var(--danger-600); }
.tm-ob-team__who { flex: 1; min-inline-size: 0; display: flex; flex-direction: column; }
.tm-ob-team__address {
  font-size: var(--t-ui-sm); line-height: var(--t-ui-sm-line); font-weight: 500; color: var(--ink-950);
  overflow-wrap: anywhere;
}
.tm-ob-team__row[data-tone] .tm-ob-team__address { font-weight: 600; color: var(--ink-800); }
.tm-ob-team__problem { margin: 0; font-size: 11px; line-height: 16px; color: var(--ink-650); }
.tm-ob-team__badge {
  flex-shrink: 0; padding: 5px 12px; border: var(--b-quiet) solid var(--line-300); border-radius: var(--r-capsule);
  background: var(--paper-0); font-size: 11px; line-height: 15px; font-weight: 500; color: var(--ink-800);
}
.tm-ob-team__remove {
  flex-shrink: 0; display: grid; place-items: center; inline-size: 32px; block-size: 32px; padding: 0;
  border: 0; border-radius: var(--r-capsule); background: transparent; color: var(--ink-500);
  font: 500 11px/1 var(--font-mono); cursor: pointer;
}
.tm-ob-team__remove:hover { background: var(--paper-150); color: var(--ink-950); }
.tm-ob-team__remove:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.tm-ob-team__result { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: var(--r-control); background: var(--paper-50); }
.tm-ob-team__result-head { display: flex; align-items: center; gap: 10px; }
.tm-ob-team__result-head .tm-ob-team__address { flex: 1; }
.tm-ob-team__link { margin: 0; font-family: var(--font-mono); font-size: var(--t-caption); line-height: var(--t-caption-line); color: var(--ink-950); overflow-wrap: anywhere; }
.tm-ob-team__night {
  display: flex; flex-direction: column; gap: 12px; padding: 20px; border-radius: var(--r-card);
  background: #121311; color: #f5f6f0;
}
[data-theme='dark'] .tm-ob-team__night { border: var(--b-quiet) solid var(--line-300); background: #1b1d19; }
.tm-ob-team__night .tm-ob-eyebrow { color: #a7aca0; }
.tm-ob-team__grants { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.tm-ob-team__grants li { font-size: var(--t-ui-sm); line-height: 19px; font-weight: 500; }
.tm-ob-team__night-rule { block-size: 1px; margin: 4px 0; border: 0; background: #3a3e35; }
.tm-ob-team__withholds, .tm-ob-team__note { margin: 0; font-size: var(--t-caption); line-height: var(--t-caption-line); color: #a7aca0; }
.tm-ob-team__withholds { color: #f5f6f0; }
.tm-ob-team__night .tm-ob-actions { margin-block-start: 10px; }
.tm-ob-team__night .tm-button--lime:disabled { opacity: 0.55; background: var(--lime-500); color: var(--tm-ink-absolute); }
.tm-ob-team__skip {
  display: inline-flex; align-items: center; min-block-size: 48px; padding: 0 18px; border-radius: var(--r-capsule);
  background: #242720; color: #f5f6f0; font-size: var(--t-caption); line-height: var(--t-caption-line);
  font-weight: 500; text-decoration: none; white-space: nowrap;
}
.tm-ob-team__skip:hover { background: #2c2e29; }
.tm-ob-team__skip:focus-visible { outline: none; box-shadow: var(--focus-ring); }
@media (max-width: 60rem) {
  .tm-ob-team { grid-template-columns: minmax(0, 1fr); }
  .tm-ob-team__add { flex-wrap: wrap; }
  .tm-ob-team__email { flex-basis: 100%; }
  .tm-ob-team__role { flex: 1; }
}
`;
