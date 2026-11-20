'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Avatar, Button, Checkbox, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  acceptInvitation,
  previewInvitation,
  registerForInvitation,
} from '../../lib/api/invitations';
import type { InvitationPreview } from '../../lib/api/invitations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { useRoleDescription } from '../../lib/use-role-description';
import type { ApiClient } from '../../lib/api/client';
import { authBoundary, type AuthBoundary } from '../../lib/auth-boundary';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { GETTING_IN_MIN_PASSWORD, gettingIn, type GettingInKey } from '../../lib/public-signup';
import {
  GoogleErrorMessage,
  GoogleSignInButton,
  googleErrorKey,
  useGoogleAvailability,
} from './GoogleSignInButton';
import { providerOffered } from '../../lib/api/provider-availability';
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

/** `users.display_name` is `VARCHAR(190)`. */
const MAX_NAME = 190;

/** The button row of the frames: the primary button at its own width, the text link beside it. */
const ACTION_ROW = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'var(--s5)',
} as const;

/**
 * **Invitation** (`/invitations/[token]`), Figma t1-a (369:1215 EN, 369:1381 AR).
 *
 * The token is previewed (`POST /v1/invitations/previews`) and the card names who invited the
 * person, to which organization and as which role. An address with no account gets the t1-a
 * form — work email (locked, from the invitation), full name, password, confirmation and the
 * terms — and one call (`/registrations`) creates the account, joins and signs in. An address
 * that already has an account gets the same card with the Accept button (`/acceptances`).
 *
 * The token is never rendered: it goes from the route straight into request bodies. The API
 * answers 404 for every unusable token alike, and this screen does not guess which case it is;
 * what the API does distinguish (409 already a member, 409 account exists, 401, 429) is said.
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
      <IdentityShell brand={false}>
        <h1 className="tm-identity__title">{t('InvitationScreen.yourInvitation')}</h1>
        <LoadingRegion label={t('InvitationScreen.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      </IdentityShell>
    );
  }

  if (preview.isError || !preview.data) {
    return (
      <IdentityShell brand={false}>
        <h1 className="tm-identity__title">{t('InvitationScreen.yourInvitation')}</h1>
        <InlineAlert tone="danger" title={t('InvitationScreen.linkNotUsable')} live>
          {preview.error instanceof NetworkError
            ? t('invitation.refusal.network')
            : t('InvitationScreen.previewErrorFallback')}
        </InlineAlert>
      </IdentityShell>
    );
  }

  const invitation = preview.data;
  const registering = invitation.hasAccount === false;

  return (
    <Card invitation={invitation} registering={registering} failure={failure}>
      {registering ? (
        <Registration
          api={api}
          token={token}
          invitation={invitation}
          boundary={boundary}
          {...(onAccepted ? { onAccepted } : {})}
        />
      ) : (
        <div style={ACTION_ROW}>
          <Button
            tone="ink"
            size="accessible"
            loading={accept.isPending}
            loadingLabel={gettingIn(t, 'GettingIn.accepting')}
            onClick={() => {
              setFailure(undefined);
              accept.mutate();
            }}
          >
            {gettingIn(t, 'GettingIn.accept')}
          </Button>
        </div>
      )}
    </Card>
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

type RegistrationField = 'displayName' | 'password' | 'confirm' | 'agree';

/** t1-a: name and password for somebody who has never had an account. */
function Registration({ api, token, invitation, boundary, onAccepted }: RegistrationProps) {
  const t = useT();
  const g = (key: GettingInKey) => gettingIn(t, key);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RegistrationField, string>>>({});
  const google = providerOffered(useGoogleAvailability(api));
  const [googleError, setGoogleError] = useState<MessageKey | undefined>(undefined);
  useEffect(() => setGoogleError(googleErrorKey(window.location.search)), []);

  function check(): Partial<Record<RegistrationField, string>> {
    const problems: Partial<Record<RegistrationField, string>> = {};
    if (displayName.trim() === '') problems.displayName = g('GettingIn.nameMissing');
    if (password.length < GETTING_IN_MIN_PASSWORD) problems.password = g('GettingIn.passwordShort');
    else if (confirm !== password) problems.confirm = g('GettingIn.passwordMismatch');
    if (!agreed) problems.agree = g('GettingIn.mustAgree');
    return problems;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(undefined);
    const problems = check();
    setFieldErrors(problems);
    if (Object.keys(problems).length > 0) {
      setFailure(g('GettingIn.fieldsNeedAttention'));
      return;
    }
    setSubmitting(true);
    try {
      const outcome = await registerForInvitation(api, token, {
        displayName: displayName.trim(),
        password,
      });
      setPassword('');
      setConfirm('');
      api.rememberCsrfToken(outcome.csrfToken);
      boundary.announce('signed-in');
      onAccepted?.(outcome.organizationId);
    } catch (error) {
      if (error instanceof ApiRequestError && [400, 422].includes(error.status)) {
        const byField = error.fieldErrors();
        const next: Partial<Record<RegistrationField, string>> = {};
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
      {googleError ? (
        <InlineAlert tone="danger" live>
          <GoogleErrorMessage messageKey={googleError} />
        </InlineAlert>
      ) : null}
      {google ? (
        <>
          {/* Google's email must equal the invited one; the API refuses any other. */}
          <div className="tm-id-methods">
            <GoogleSignInButton
              api={api}
              input={() => ({ intent: 'invitation', invitationToken: token })}
            />
          </div>
          <p className="tm-divider">{t('google.or')}</p>
        </>
      ) : null}
      {/* The invitation's own address, locked: the API ignores any other. */}
      <Field
        label={g('GettingIn.workEmail')}
        type="email"
        name="email"
        autoComplete="username"
        dir="ltr"
        value={invitation.inviteeEmail}
        readOnly
        aria-readonly="true"
        hint={g('GettingIn.fromInvitation')}
      />
      <Field
        label={g('GettingIn.fullName')}
        name="displayName"
        autoComplete="name"
        maxLength={MAX_NAME}
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        required
        disabled={submitting}
        {...errorProp(fieldErrors.displayName)}
      />
      <Field
        label={g('GettingIn.password')}
        type="password"
        name="password"
        autoComplete="new-password"
        minLength={GETTING_IN_MIN_PASSWORD}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        hint={g('GettingIn.passwordHint')}
        required
        disabled={submitting}
        {...errorProp(fieldErrors.password)}
      />
      <Field
        label={g('GettingIn.confirmPassword')}
        type="password"
        name="confirmPassword"
        autoComplete="new-password"
        placeholder={g('GettingIn.confirmPlaceholder')}
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        required
        disabled={submitting}
        {...errorProp(fieldErrors.confirm)}
      />
      <Checkbox
        label={g('GettingIn.agree')}
        name="agree"
        checked={agreed}
        onChange={(event) => setAgreed(event.target.checked)}
        disabled={submitting}
        {...errorProp(fieldErrors.agree)}
      />
      {failure ? (
        <InlineAlert tone="danger" title={t('InvitationScreen.didNotGoThrough')} live>
          {failure}
        </InlineAlert>
      ) : null}
      <div style={ACTION_ROW}>
        <Button
          type="submit"
          tone="ink"
          size="accessible"
          loading={submitting}
          loadingLabel={g('GettingIn.creatingAccount')}
        >
          {g('GettingIn.createAndJoin')}
        </Button>
        <Link className="tm-id-link" href="/sign-in">
          {g('GettingIn.signInInstead')}
        </Link>
      </div>
    </form>
  );
}

interface CardProps {
  invitation: InvitationPreview;
  registering: boolean;
  failure: string | undefined;
  children: ReactNode;
}

/** The t1-a card: inviter line, title, the role sentence, the form, the expiry note. */
function Card({ invitation, registering, failure, children }: CardProps) {
  const t = useT();
  const describeRole = useRoleDescription();
  const locale = useActiveLocale();
  const isClient = invitation.audience === 'client';
  const role = describeRole(invitation.role).label;

  return (
    <IdentityShell brand={false}>
      <div className="tm-id-inviter">
        <Avatar name={invitation.inviterName} audience={invitation.audience} decorative />
        <div>
          <p className="tm-id-inviter__name">
            {gettingIn(t, 'GettingIn.invitedLine', {
              inviter: invitation.inviterName,
              organization: invitation.organizationName,
            })}
          </p>
          <p className="tm-id-inviter__meta">
            <span dir="ltr">{invitation.inviterEmail}</span> ·{' '}
            {formatDay(invitation.invitedAt, locale, 'short')}
          </p>
        </div>
      </div>

      <div className="tm-id-intro">
        <h1 className="tm-identity__title">
          {registering
            ? gettingIn(t, 'GettingIn.createTitle')
            : gettingIn(t, 'GettingIn.joinTitle', { organization: invitation.organizationName })}
        </h1>
        <p className="tm-id-lede">
          {gettingIn(t, registering ? 'GettingIn.joiningAs' : 'GettingIn.joiningAsExisting', {
            role,
          })}
        </p>
      </div>

      {isClient ? (
        <InlineAlert tone="client" title={t('InvitationScreen.clientPortalTitle')}>
          {t('InvitationScreen.clientPortalBefore')} {invitation.organizationName}
          {t('InvitationScreen.clientPortalAfter')}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title={t('InvitationScreen.didNotGoThrough')} live>
          {failure}
        </InlineAlert>
      ) : null}

      {children}

      <InlineAlert tone="neutral">
        {gettingIn(t, 'GettingIn.expiresOn', {
          date: formatDay(invitation.expiresAt, locale, 'long'),
        })}
      </InlineAlert>
    </IdentityShell>
  );
}

function errorProp(message: string | undefined): { error?: string } {
  return message === undefined ? {} : { error: message };
}

/** "13 Aug" / "20 August" as the frames write it; Arabic keeps Latin digits like the AR frame. */
function formatDay(value: string, locale: string, month: 'short' | 'long'): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const tag = locale.toLowerCase().startsWith('ar') ? 'ar-u-nu-latn' : 'en-GB';
  return new Intl.DateTimeFormat(tag, { day: 'numeric', month }).format(parsed);
}
