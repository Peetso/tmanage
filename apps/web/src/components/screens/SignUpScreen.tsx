'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from '../website/WebLink';
import { Badge, Button, Checkbox, Field, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchSignupAvailability, signUp } from '../../lib/api/sign-up';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { authBoundary, type AuthBoundary } from '../../lib/auth-boundary';
import { useHydrated } from '../../lib/use-hydrated';
import { useFormProof } from '../../lib/form-proof';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { readsApiLanguage, refusalLine } from '../../lib/api/auth-refusal';
import { GETTING_IN_MIN_PASSWORD, gettingIn, type GettingInKey } from '../../lib/public-signup';
import {
  GoogleErrorMessage,
  GoogleSignInButton,
  googleErrorKey,
  useGoogleAvailability,
} from './GoogleSignInButton';
import {
  MicrosoftErrorMessage,
  MicrosoftSignInButton,
  microsoftErrorOf,
  useMicrosoftAvailability,
} from './MicrosoftSignInButton';
import { InAppBrowserNotice, useInAppBrowser } from './InAppBrowserNotice';
import type { GoogleStartInput } from '../../lib/api/google-auth';
import '../../styles/screens/identity.css';

const MAX_NAME = 190;
const MAX_EMAIL = 254;

type SignUpField = 'displayName' | 'email' | 'password' | 'organizationName' | 'agree';
const API_FIELDS: readonly SignUpField[] = ['displayName', 'email', 'password', 'organizationName'];

type Availability = 'checking' | 'available' | 'unavailable' | 'failed';

/** What the check-your-email state needs once the workspace exists. */
interface Created {
  readonly email: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
}

/** The button row of the frame: the button at its own width, not stretched. */
const ACTION_ROW = { display: 'flex', alignItems: 'center', gap: 'var(--s5)' } as const;

export interface SignUpScreenProps {
  client?: ApiClient;
  /**
   * Called with the new workspace's slug when the person leaves the check-your-email state.
   * Default: full navigation to its home.
   */
  onCompleted?: (organizationSlug: string) => void;
  boundary?: AuthBoundary;
  /** Rendered above the form — the "Continue with Google" button when configured. */
  alternatives?: ReactNode;
}

/**
 * **Start free** (`/sign-up`), Figma t1-c (369:1289 EN, 369:1459 AR).
 *
 * Public self-service account creation on `lib/api/sign-up.ts`: full name, work email,
 * organization name and password create the person and a new organization they own, and sign
 * them in. The API sends a welcome email, so success shows the check-your-email state with a
 * button into the new workspace. With the API's `PUBLIC_SIGNUP` switch off (404) the screen
 * says sign-up is not open and shows no form.
 */
export function SignUpScreen({
  client,
  onCompleted,
  boundary = authBoundary,
  alternatives,
}: SignUpScreenProps) {
  const api = client ?? browserApiClient();
  const hydrated = useHydrated();
  const t = useT();
  const g = (key: GettingInKey) => gettingIn(t, key);
  const locale = useActiveLocale();

  const [availability, setAvailability] = useState<Availability>('checking');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [accountExists, setAccountExists] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SignUpField, string>>>({});
  const [created, setCreated] = useState<Created | undefined>(undefined);
  const google = useGoogleAvailability(api);
  const [googleError, setGoogleError] = useState<MessageKey | undefined>(undefined);
  // 52-21: the invisible form proof, fetched once when the form is shown.
  const formProof = useFormProof(api);
  // 51-05 "Continue with Microsoft", beside Google.
  const microsoft = useMicrosoftAvailability(api);
  // LANDFIX: inside Facebook/Instagram/TikTok webviews the providers refuse the sign-in.
  const inAppBrowser = useInAppBrowser();
  const [microsoftError, setMicrosoftError] = useState<readonly [string, string] | undefined>(
    undefined,
  );
  /** Read at click time, so a workspace name typed before choosing a provider is kept. */
  const signUpInput = (): GoogleStartInput => ({
    intent: 'sign-up',
    ...(organizationName.trim() === '' ? {} : { organizationName: organizationName.trim() }),
  });
  useEffect(() => {
    setGoogleError(googleErrorKey(window.location.search));
    setMicrosoftError(microsoftErrorOf(window.location.search));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSignupAvailability(api)
      .then((open) => {
        if (!cancelled) setAvailability(open ? 'available' : 'unavailable');
      })
      .catch(() => {
        if (!cancelled) setAvailability('failed');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearFieldError(field: SignUpField) {
    setFailure(undefined);
    setAccountExists(false);
    setFieldErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function complete(organizationSlug: string) {
    if (onCompleted) onCompleted(organizationSlug);
    else window.location.assign(`/${encodeURIComponent(organizationSlug)}/home`);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(undefined);
    setAccountExists(false);
    setFieldErrors({});

    const missing: Partial<Record<SignUpField, string>> = {};
    if (displayName.trim() === '') missing.displayName = g('GettingIn.nameMissing');
    if (email.trim() === '') missing.email = g('GettingIn.emailMissing');
    if (organizationName.trim() === '') {
      missing.organizationName = g('GettingIn.organizationMissing');
    }
    if (password.length < GETTING_IN_MIN_PASSWORD) missing.password = g('GettingIn.passwordShort');
    if (!agreed) missing.agree = g('GettingIn.mustAgree');
    if (Object.keys(missing).length > 0) {
      setFieldErrors(missing);
      setFailure(g('GettingIn.fieldsNeedAttention'));
      return;
    }

    setSubmitting(true);
    try {
      const outcome = await signUp(api, {
        displayName: displayName.trim(),
        email: email.trim(),
        password,
        organizationName: organizationName.trim(),
        timezone: guessTimezone(),
        defaultLocale: locale.toLowerCase().startsWith('ar') ? 'ar' : 'en',
        website,
        ...(await formProof.fields()),
      });
      setPassword('');
      api.rememberCsrfToken(outcome.csrfToken);
      boundary.announce('signed-in');
      setCreated({
        email: email.trim(),
        organizationName: organizationName.trim(),
        organizationSlug: outcome.organizationSlug,
      });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        setAvailability('unavailable');
        setPassword('');
        return;
      }
      if (error instanceof ApiRequestError && error.status === 409) {
        setAccountExists(true);
        setFailure(t('signUp.accountExists'));
        return;
      }
      if (error instanceof ApiRequestError && [400, 422].includes(error.status)) {
        const byField = error.fieldErrors();
        const next: Partial<Record<SignUpField, string>> = {};
        for (const field of API_FIELDS) {
          const message = byField.get(field);
          // The API words field errors in English; another language gets the catalog's line.
          if (message !== undefined) {
            next[field] = readsApiLanguage(locale) ? message : t('AuthRefusal.checkField');
          }
        }
        setFieldErrors(next);
      }
      const line = refusalLine(error, locale);
      setFailure(line === undefined ? describe(error, t) : t(line));
    } finally {
      setSubmitting(false);
    }
  }

  if (availability === 'unavailable') {
    return (
      <IdentityShell brand={false}>
        <div className="tm-id-intro">
          <h1 className="tm-identity__title">{t('signUp.unavailableTitle')}</h1>
          <p className="tm-id-lede">
            {t('signUp.unavailableBody')}{' '}
            <Link className="tm-id-link" href="/sign-in">
              {t('signUp.signIn')}
            </Link>
          </p>
        </div>
      </IdentityShell>
    );
  }

  if (created) {
    return (
      <IdentityShell brand={false}>
        <div className="tm-id-intro">
          <h1 className="tm-identity__title">{g('GettingIn.checkEmailTitle')}</h1>
          <p className="tm-id-lede">
            {gettingIn(t, 'GettingIn.checkEmailBody', {
              email: created.email,
              organization: created.organizationName,
            })}
          </p>
        </div>
        <div style={ACTION_ROW}>
          <Button tone="lime" size="accessible" onClick={() => complete(created.organizationSlug)}>
            {g('GettingIn.openWorkspace')}
          </Button>
        </div>
      </IdentityShell>
    );
  }

  return (
    <IdentityShell brand={false}>
      <div className="tm-id-intro">
        <p>
          <Badge>{g('GettingIn.freePlan')}</Badge>
        </p>
        <h1 className="tm-identity__title">{g('GettingIn.startTitle')}</h1>
        <p className="tm-id-lede">{g('GettingIn.startLede')}</p>
      </div>

      {availability === 'checking' ? (
        <InlineAlert tone="neutral" live>
          {t('signUp.checking')}
        </InlineAlert>
      ) : null}

      {availability === 'failed' ? (
        <InlineAlert tone="danger" title={t('signUp.failureTitle')} live>
          {t('signUp.network')}
        </InlineAlert>
      ) : null}

      {availability === 'available' ? (
        <>
          {googleError ? (
            <InlineAlert tone="danger" live>
              <GoogleErrorMessage messageKey={googleError} />
            </InlineAlert>
          ) : null}
          {microsoftError ? (
            <InlineAlert tone="danger" live>
              <MicrosoftErrorMessage error={microsoftError} />
            </InlineAlert>
          ) : null}
          {alternatives}
          {!inAppBrowser.inApp && (google?.signUp || microsoft?.signUp) ? (
            <>
              <div className="tm-id-methods">
                {google?.signUp ? <GoogleSignInButton api={api} input={signUpInput} /> : null}
                {microsoft?.signUp ? <MicrosoftSignInButton api={api} input={signUpInput} /> : null}
              </div>
              <p className="tm-divider">{t('google.or')}</p>
            </>
          ) : null}
          <form className="tm-stack tm-stack--loose" noValidate onSubmit={submit}>
            <fieldset className="tm-fieldset tm-stack" disabled={!hydrated || submitting}>
              <Field
                label={g('GettingIn.fullName')}
                name="displayName"
                autoComplete="name"
                maxLength={MAX_NAME}
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                  clearFieldError('displayName');
                }}
                required
                {...errorProp(fieldErrors.displayName)}
              />
              <Field
                label={g('GettingIn.workEmail')}
                type="email"
                name="email"
                autoComplete="username"
                inputMode="email"
                dir="ltr"
                maxLength={MAX_EMAIL}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  clearFieldError('email');
                }}
                required
                {...errorProp(fieldErrors.email)}
              />
              <Field
                label={g('GettingIn.organizationName')}
                name="organizationName"
                autoComplete="organization"
                maxLength={MAX_NAME}
                value={organizationName}
                onChange={(event) => {
                  setOrganizationName(event.target.value);
                  clearFieldError('organizationName');
                }}
                hint={g('GettingIn.organizationHint')}
                required
                {...errorProp(fieldErrors.organizationName)}
              />
              <Field
                label={g('GettingIn.password')}
                type="password"
                name="password"
                autoComplete="new-password"
                minLength={GETTING_IN_MIN_PASSWORD}
                placeholder={g('GettingIn.passwordHint')}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  clearFieldError('password');
                }}
                required
                {...errorProp(fieldErrors.password)}
              />
              <Checkbox
                label={g('GettingIn.agree')}
                name="agree"
                checked={agreed}
                onChange={(event) => {
                  setAgreed(event.target.checked);
                  clearFieldError('agree');
                }}
                {...errorProp(fieldErrors.agree)}
              />
              {/* Honeypot: hidden from people and from assistive technology; bots fill it. */}
              <div hidden aria-hidden="true">
                <Field
                  label={t('signUp.honeypot')}
                  name="website"
                  autoComplete="off"
                  tabIndex={-1}
                  value={website}
                  onChange={(event) => setWebsite(event.target.value)}
                />
              </div>
              {/* 52-21 form proof: invisible; the submit adds the browser-computed proof. */}
              <input type="hidden" name="startedAt" value={formProof.issue?.startedAt ?? ''} />
              <input type="hidden" name="nonce" value={formProof.issue?.nonce ?? ''} />
            </fieldset>

            {failure ? (
              <InlineAlert tone="danger" title={t('signUp.failureTitle')} live>
                {failure}
                {accountExists ? (
                  <>
                    {' '}
                    <Link href="/sign-in">{t('signUp.signIn')}</Link>
                  </>
                ) : null}
              </InlineAlert>
            ) : null}

            <div style={ACTION_ROW}>
              <Button
                type="submit"
                tone="lime"
                size="accessible"
                loading={submitting}
                loadingLabel={g('GettingIn.creatingWorkspace')}
                disabled={!hydrated}
              >
                {g('GettingIn.createWorkspace')}
              </Button>
            </div>
          </form>
          {inAppBrowser.inApp ? (
            <InAppBrowserNotice
              google={google?.signUp === true}
              microsoft={microsoft?.signUp === true}
              android={inAppBrowser.android}
            />
          ) : null}
        </>
      ) : null}

      <p className="tm-id-lede">
        {t('signUp.haveAccount')}{' '}
        <Link className="tm-id-link" href="/sign-in">
          {t('signUp.signIn')}
        </Link>
      </p>
    </IdentityShell>
  );
}

function errorProp(message: string | undefined): { error?: string } {
  return message === undefined ? {} : { error: message };
}

function describe(error: unknown, t: (key: MessageKey) => string): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 429) return t('signUp.rateLimited');
    if (error.status === 400 || error.status === 422) return error.message;
    return t('signUp.generic');
  }
  if (error instanceof NetworkError) return t('signUp.network');
  return t('signUp.generic');
}

function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
