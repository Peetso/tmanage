'use client';

import { Avatar, Badge, Button, InlineAlert, StateCapsule } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { BackendPending } from './BackendPending';

export interface InvitationDetails {
  readonly inviterName: string;
  readonly inviterEmail: string;
  readonly invitedAt: string;
  readonly organizationName: string;
  readonly projectName: string;
  readonly roleName: string;
  /** e.g. "approval authority". Rendered beside the role, never instead of it. */
  readonly roleQualifier?: string;
  /** Whether this invitation grants portal access rather than team membership. */
  readonly audience: 'internal' | 'client';
  /** Plain sentences. Each one is a thing the person *will* be able to see. */
  readonly willSee: readonly string[];
  /** The single sentence naming everything they will not see. */
  readonly willNotSee: string;
  readonly expiresOn: string;
}

export interface InvitationScreenProps {
  /**
   * The invitation, or `undefined` when it could not be loaded.
   *
   * There is no endpoint that returns one — invitations are TEN-003, unwritten — so the page
   * passes a fixture and says so. The prop is required rather than defaulted so that no
   * caller can render this screen while believing it fetched something.
   */
  invitation: InvitationDetails;
}

/**
 * **ID-03 Invitation acceptance.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Show inviter, organization, project, role, exact access
 * summary, expiry, account-switch option. Client invitation prominently states 'client
 * portal access,' not team membership."
 *
 * The access summary is the point of this screen, so it is a list of sentences rather than a
 * role name the reader has to interpret. `12-PERMISSION-MATRIX` decides what a role can do;
 * a person accepting an invitation cannot be expected to have read it, so the invitation
 * states the consequences in words.
 *
 * The "will not see" sentence is rendered with equal weight, not as fine print. For a client
 * invitation it is the sentence that makes the boundary real — and `26-THREAT-MODELS` treats
 * a client who believes they can see internal costs as a disclosure risk waiting to happen.
 *
 * Expiry is stated as a date, and the copy says plainly that an expired link is never
 * extended. That mirrors `ID-05`'s recovery rule and `04-SECURITY-PRIVACY` §3.
 */
export function InvitationScreen({ invitation }: InvitationScreenProps) {
  const isClient = invitation.audience === 'client';

  return (
    <IdentityShell screenId="ID-03" eyebrow="Invitation">
      <div className="tm-row">
        <Avatar name={invitation.inviterName} audience={invitation.audience} />
        <div className="tm-stack tm-stack--tight">
          <h1 className="tm-identity__title">{invitation.inviterName} invited you</h1>
          <p className="tm-prose tm-mono">
            {invitation.inviterEmail} · {invitation.invitedAt}
          </p>
        </div>
      </div>

      <BackendPending ticket="TEN-003">
        Invitations are not stored or accepted yet. The details below are a fixture supplied by the
        page, not a record fetched for a token.
      </BackendPending>

      <p className="tm-prose">
        Join <strong>{invitation.organizationName}</strong> on{' '}
        <strong>{invitation.projectName}</strong>.
      </p>

      {isClient ? (
        <InlineAlert tone="client" title="This is client portal access">
          You are being given access to {invitation.organizationName}&rsquo;s client portal. It is
          not membership of the delivery team.
        </InlineAlert>
      ) : null}

      <section className="tm-panel tm-stack" aria-labelledby="tm-invitation-role">
        <h2 id="tm-invitation-role" className="tm-eyebrow">
          Role
        </h2>
        <div className="tm-row">
          <StateCapsule state={isClient ? 'client' : 'current'}>{invitation.roleName}</StateCapsule>
          {invitation.roleQualifier ? <Badge mono>{invitation.roleQualifier}</Badge> : null}
        </div>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-invitation-access">
        <h2 id="tm-invitation-access" className="tm-eyebrow">
          Exactly what you will see
        </h2>
        <ul className="tm-stack tm-stack--tight tm-list">
          {invitation.willSee.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="tm-prose">
          <strong>{invitation.willNotSee}</strong>
        </p>
      </section>

      <div className="tm-row">
        <Button tone="ink" size="accessible" disabled>
          Accept and set up a passkey
        </Button>
        <Button tone="text" disabled>
          Decline
        </Button>
        <Button tone="text" disabled>
          Use a different account
        </Button>
      </div>

      <InlineAlert tone="warning" title="This invitation expires">
        It expires on {invitation.expiresOn}. After that, ask {invitation.inviterName} for a new one
        — expired links never grant access.
      </InlineAlert>
    </IdentityShell>
  );
}
