'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Avatar, Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  acceptInvitation,
  previewInvitation,
  registerForInvitation,
} from '../../lib/api/invitations';
import type { InvitationPreview } from '../../lib/api/invitations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { describeInternalRole } from '../../lib/roles';
import type { ApiClient } from '../../lib/api/client';
import { authBoundary, type AuthBoundary } from '../../lib/auth-boundary';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import '../../styles/screens/identity.css';

export interface InvitationScreenProps {
  /** From the route. Sent in a body, never rendered into the document. */
  token: string;
  client?: ApiClient;
  /** Called with the organization the person just joined. */
  onAccepted?: (organizationId: string) => void;
  /** Told when a registration signs the new person in. Injected by tests. */
  boundary?: AuthBoundary;
}

/** `PASSWORD_MIN_LENGTH` in `apps/api/src/modules/identity/password.ts`. */
const MIN_PASSWORD = 8;
/** `users.display_name` is `VARCHAR(190)`. */
const MAX_NAME = 190;

/**
 * **ID-03 Invitation acceptance.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Show inviter, organization, project, role, exact access summary,
 * expiry, account-switch option. Client invitation prominently states 'client portal access,'
 * not team membership."
 *
 * It previews the token, renders what the API returns, and then does one of two things:
 *
 * - **The address has no account** (`hasAccount: false`, ACC-01): it asks for a name and a
 *   password, and one call creates the account, joins, and signs the person in. Before this a
 *   brand-new invitee was sent to a sign-in screen they could never pass.
 * - **The address has an account**: the Accept button, as before. A signed-out person who
 *   presses it is sent to sign-in and brought back here afterwards.
 *
 * ## The token is never in the document
 *
 * It arrives in the route — that is where an emailed link puts it — and goes straight into a
 * request body. It is not rendered, not put in a hidden field, and not echoed in any error.
 * A token in the DOM is in every screenshot and every crash report, and this one grants
 * membership in an organization. The same rule `ID-02`'s MFA challenge token follows, and a
 * test asserts it for both.
 *
 * ## Refusals
 *
 * The API answers 404 for a token that never existed, one that was revoked, one that expired
 * and one already used; this screen does not try to guess which — distinguishing them would
 * rebuild the oracle the API refuses to be. What the API *does* distinguish is said plainly:
 * 409 "already a member" (ACC-04, which used to read as "cannot be accepted any more"), 409
 * "an account already uses this address" on registration, 401 "sign in first", 429. The
 * sentences are in `lib/i18n/messages` in English and Arabic.
 *
 * ## What is still missing, and is said rather than implied
 *
 * `22` §3 lists a **project** on this screen. An invitation names none — `0005_invitations.sql`
 * has no column for one and `23-ERD` §9 does not give it one — so the screen names the
 * organization and the role and does not invent a project.
 */
export function InvitationScreen({
  token,
  client,
  onAccepted,
  boundary = authBoundary,
}: InvitationScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
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
    onError: (error) => setFailure(t(refusalKey(error))),
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
        <LoadingRegion label="Loading this invitation.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      </IdentityShell>
    );
  }

  if (preview.isError || !preview.data) {
    return (
      <IdentityShell screenId="ID-03" eyebrow="Invitation">
        <h1 className="tm-identity__title">Your invitation</h1>
        <InlineAlert tone="danger" title="This link is not usable" live>
          {preview.error instanceof NetworkError
            ? t('invitation.refusal.network')
            : 'It may have been used already, withdrawn, or expired. Ask whoever invited you for a new one — expired links are never extended.'}
        </InlineAlert>
      </IdentityShell>
    );
  }

  return (
    <Details invitation={preview.data} failure={failure}>
      {preview.data.hasAccount === false ? (
        <Registration
          api={api}
          token={token}
          invitation={preview.data}
          boundary={boundary}
          {...(onAccepted ? { onAccepted } : {})}
        />
      ) : (
        <div className="tm-id-action-row">
          <Button
            tone="ink"
            size="accessible"
            loading={accept.isPending}
            loadingLabel="Accepting"
            onClick={() => {
              setFailure(undefined);
              accept.mutate();
            }}
          >
            Accept invitation
          </Button>
        </div>
      )}
    </Details>
  );
}

/** The sentence for a refusal the API actually distinguishes. */
function refusalKey(error: unknown): MessageKey {
  if (error instanceof NetworkError) return 'invitation.refusal.network';
  if (!(error instanceof ApiRequestError)) return 'invitation.refusal.generic';
  if (error.status === 404) return 'invitation.refusal.unusable';
  if (error.status === 401) return 'invitation.refusal.signIn';
  if (error.status === 429) return 'invitation.refusal.rateLimited';
  if (error.status === 409) {
    const field = error.fieldErrors();
    if (field.get('email') === 'account_exists') return 'invitation.refusal.accountExists';
    if (field.get('token') === 'already_member') return 'invitation.refusal.alreadyMember';
  }
  return 'invitation.refusal.generic';
}

interface RegistrationProps {
  api: ApiClient;
  token: string;
  invitation: InvitationPreview;
  boundary: AuthBoundary;
  onAccepted?: (organizationId: string) => void;
}

/**
 * ACC-01: name and password for somebody who has never had an account. The email is the
 * invitation's own and is shown, not editable — the API takes it from the invitation row.
 */
function Registration({ api, token, invitation, boundary, onAccepted }: RegistrationProps) {
  const t = useT();
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [fieldErrors, setFieldErrors] = useState<{ displayName?: string; password?: string }>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(undefined);
    setFieldErrors({});
    setSubmitting(true);
    try {
      const outcome = await registerForInvitation(api, token, {
        displayName: displayName.trim(),
        password,
      });
      setPassword('');
      api.rememberCsrfToken(outcome.csrfToken);
      boundary.announce('signed-in');
      onAccepted?.(outcome.organizationId);
    } catch (error) {
      if (error instanceof ApiRequestError && [400, 422].includes(error.status)) {
        const byField = error.fieldErrors();
        const next: { displayName?: string; password?: string } = {};
        const name = byField.get('displayName');
        const pass = byField.get('password');
        if (name !== undefined) next.displayName = name;
        if (pass !== undefined) next.password = pass;
        setFieldErrors(next);
        setFailure(error.message);
      } else {
        setFailure(t(refusalKey(error)));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="tm-stack" noValidate onSubmit={(event) => void submit(event)}>
      <p className="tm-id-inviter__meta">
        New to TManage? Choose your name and a password to join.
      </p>
      {/*
        The invited address, filled in and locked: the API creates the account for the
        invitation's own email and ignores anything else, so an editable field would only
        mislead. `readOnly` (not `disabled`) keeps it focusable and read by screen readers.
      */}
      <Field
        label="Email"
        type="email"
        name="email"
        autoComplete="username"
        dir="ltr"
        value={invitation.inviteeEmail}
        readOnly
        aria-readonly="true"
        hint="From your invitation — this is the address you will sign in with."
      />
      <Field
        label="Your name"
        name="displayName"
        autoComplete="name"
        maxLength={MAX_NAME}
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        required
        disabled={submitting}
        {...(fieldErrors.displayName ? { error: fieldErrors.displayName } : {})}
      />
      <Field
        label="Password"
        type="password"
        name="password"
        autoComplete="new-password"
        minLength={MIN_PASSWORD}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        hint={`At least ${MIN_PASSWORD} characters.`}
        required
        disabled={submitting}
        {...(fieldErrors.password ? { error: fieldErrors.password } : {})}
      />
      {failure ? (
        <InlineAlert tone="danger" title="That did not go through" live>
          {failure}
        </InlineAlert>
      ) : null}
      <div className="tm-id-action-row">
        <Button
          type="submit"
          tone="ink"
          size="accessible"
          loading={submitting}
          loadingLabel="Creating your account"
        >
          Create account and join
        </Button>
      </div>
      <p className="tm-id-inviter__meta">
        Already have an account? <Link href="/sign-in">Sign in</Link>, then open this link again.
      </p>
    </form>
  );
}

interface DetailsProps {
  invitation: InvitationPreview;
  failure: string | undefined;
  children: ReactNode;
}

function Details({ invitation, failure, children }: DetailsProps) {
  const isClient = invitation.audience === 'client';
  const role = describeInternalRole(invitation.role);

  return (
    <IdentityShell screenId="ID-03" eyebrow="Invitation">
      <div className="tm-id-inviter">
        <Avatar name={invitation.inviterName} audience={invitation.audience} decorative />
        <div>
          <p className="tm-id-inviter__name">{invitation.inviterName} invited you</p>
          <p className="tm-id-inviter__meta">
            {invitation.inviterEmail} · {formatDay(invitation.invitedAt)}
          </p>
        </div>
      </div>

      <h1 className="tm-identity__title">
        Join <span>{invitation.organizationName}</span>
        {isClient && invitation.clientOrganizationName
          ? ` as part of ${invitation.clientOrganizationName}`
          : ''}
      </h1>

      {isClient ? (
        <InlineAlert tone="client" title="This is client portal access">
          You are being given access to {invitation.organizationName}&rsquo;s client portal. It is
          not membership of the delivery team.
        </InlineAlert>
      ) : null}

      <div className="tm-id-panels">
        <section className="tm-id-panel tm-id-panel--row" aria-labelledby="tm-invitation-role">
          <h2 id="tm-invitation-role" className="tm-id-panel__label">
            Role
          </h2>
          <span className="tm-id-panel__value">{role.label}</span>
          <span className={isClient ? 'tm-id-capsule tm-id-capsule--client' : 'tm-id-capsule'}>
            {isClient ? 'client portal' : 'internal team'}
          </span>
        </section>

        <section className="tm-id-panel" aria-labelledby="tm-invitation-access">
          <h2 id="tm-invitation-access" className="tm-id-panel__label">
            Exactly what you will see
          </h2>
          <ul className="tm-id-grants">
            {role.grants.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="tm-id-withholds">{role.withholds}</p>
        </section>
      </div>

      {failure ? (
        <InlineAlert tone="danger" title="That did not go through" live>
          {failure}
        </InlineAlert>
      ) : null}

      {children}

      <InlineAlert className="tm-id-note--dashed" tone="warning">
        This invitation expires on {formatDay(invitation.expiresAt)}. After that, ask{' '}
        {invitation.inviterName} for a new one — expired links never grant access.
      </InlineAlert>
    </IdentityShell>
  );
}

function formatDay(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(parsed);
}
