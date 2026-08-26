'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Avatar, Badge, Button, InlineAlert, Skeleton, StateCapsule } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { acceptInvitation, previewInvitation } from '../../lib/api/invitations';
import type { InvitationPreview } from '../../lib/api/invitations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { describeInternalRole } from '../../lib/roles';
import type { ApiClient } from '../../lib/api/client';

export interface InvitationScreenProps {
  /** From the route. Sent in a body, never rendered into the document. */
  token: string;
  client?: ApiClient;
  /** Called with the organization the person just joined. */
  onAccepted?: (organizationId: string) => void;
}

/**
 * **ID-03 Invitation acceptance.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Show inviter, organization, project, role, exact access summary,
 * expiry, account-switch option. Client invitation prominently states 'client portal access,'
 * not team membership."
 *
 * Real as of `TEN-003`. It previews the token, renders what the API returns, and accepts.
 *
 * ## The token is never in the document
 *
 * It arrives in the route — that is where an emailed link puts it — and goes straight into a
 * request body. It is not rendered, not put in a hidden field, and not echoed in any error.
 * A token in the DOM is in every screenshot and every crash report, and this one grants
 * membership in an organization. The same rule `ID-02`'s MFA challenge token follows, and a
 * test asserts it for both.
 *
 * ## Every refusal reads the same
 *
 * The API answers 404 for a token that never existed, one that was revoked, one that expired
 * and one already used. This screen does not try to guess which: it says the link is not
 * usable and to ask for a new one. Distinguishing them would rebuild the oracle the API
 * refuses to be, in the browser.
 *
 * ## What is still missing, and is said rather than implied
 *
 * `22` §3 lists a **project** on this screen. An invitation names none — `0005_invitations.sql`
 * has no column for one and `23-ERD` §9 does not give it one — so the screen names the
 * organization and the role and does not invent a project.
 *
 * "Accept and set up a passkey" is two acts, and only the first exists. The button accepts;
 * passkeys are `ID-002`'s unbuilt half.
 */
export function InvitationScreen({ token, client, onAccepted }: InvitationScreenProps) {
  const api = client ?? browserApiClient();
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const preview = useQuery({
    // The token is the identity of this query and never leaves the browser's memory: React
    // Query keys are not persisted anywhere by this application.
    queryKey: ['invitation', token],
    queryFn: () => previewInvitation(api, token),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () => acceptInvitation(api, token),
    onSuccess: (result) => onAccepted?.(result.organizationId),
    onError: (error) => {
      setFailure(
        error instanceof ApiRequestError
          ? 'This invitation cannot be accepted any more. Ask whoever invited you for a new link.'
          : error instanceof NetworkError
            ? 'The API did not answer. Is it running?'
            : 'Something went wrong. Try again.',
      );
    },
  });

  if (preview.isPending) {
    return (
      <IdentityShell screenId="ID-03" eyebrow="Invitation">
        {/*
          A heading in every state, including this one. `22-SCREEN-BY-SCREEN` §1 gives every
          screen exactly one `<h1>`, and a document whose only heading appears once a request
          resolves has no heading for the moment a screen reader lands on it.
        */}
        <h1 className="tm-identity__title">Your invitation</h1>
        <div aria-busy="true" aria-live="polite">
          <span className="tm-visually-hidden">Loading this invitation.</span>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </div>
      </IdentityShell>
    );
  }

  if (preview.isError || !preview.data) {
    return (
      <IdentityShell screenId="ID-03" eyebrow="Invitation">
        <h1 className="tm-identity__title">Your invitation</h1>
        <InlineAlert tone="danger" title="This link is not usable" live>
          {preview.error instanceof NetworkError
            ? 'The API did not answer. Is it running?'
            : 'It may have been used already, withdrawn, or expired. Ask whoever invited you for a new one — expired links are never extended.'}
        </InlineAlert>
      </IdentityShell>
    );
  }

  return <Details invitation={preview.data} failure={failure} accept={accept} />;
}

interface DetailsProps {
  invitation: InvitationPreview;
  failure: string | undefined;
  accept: {
    isPending: boolean;
    mutate: () => void;
  };
}

function Details({ invitation, failure, accept }: DetailsProps) {
  const isClient = invitation.audience === 'client';
  const role = describeInternalRole(invitation.role);

  return (
    <IdentityShell screenId="ID-03" eyebrow="Invitation">
      <div className="tm-row">
        <Avatar name={invitation.inviterName} audience={invitation.audience} />
        <div className="tm-stack tm-stack--tight">
          <h1 className="tm-identity__title">{invitation.inviterName} invited you</h1>
          <p className="tm-prose tm-mono">
            {invitation.inviterEmail} · {formatDay(invitation.invitedAt)}
          </p>
        </div>
      </div>

      <p className="tm-prose">
        Join <strong>{invitation.organizationName}</strong>
        {isClient && invitation.clientOrganizationName
          ? ` as part of ${invitation.clientOrganizationName}`
          : ''}
        .
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
          <StateCapsule state={isClient ? 'client' : 'current'}>{role.label}</StateCapsule>
          <Badge mono>{invitation.role}</Badge>
        </div>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-invitation-access">
        <h2 id="tm-invitation-access" className="tm-eyebrow">
          Exactly what you will see
        </h2>
        <ul className="tm-stack tm-stack--tight tm-list">
          {role.grants.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="tm-prose">
          <strong>{role.withholds}</strong>
        </p>
      </section>

      {failure ? (
        <InlineAlert tone="danger" title="That did not go through" live>
          {failure}
        </InlineAlert>
      ) : null}

      <div className="tm-row">
        <Button
          tone="ink"
          size="accessible"
          loading={accept.isPending}
          loadingLabel="Accepting"
          onClick={() => accept.mutate()}
        >
          Accept invitation
        </Button>
      </div>

      <InlineAlert tone="warning" title="This invitation expires">
        It expires on {formatDay(invitation.expiresAt)}. After that, ask {invitation.inviterName}{' '}
        for a new one — expired links never grant access.
      </InlineAlert>
    </IdentityShell>
  );
}

function formatDay(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(parsed);
}
