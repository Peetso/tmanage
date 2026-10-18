'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchSignupAvailability, signUp } from '../../lib/api/sign-up';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { authBoundary, type AuthBoundary } from '../../lib/auth-boundary';
import { useHydrated } from '../../lib/use-hydrated';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import '../../styles/screens/identity.css';

/** `PASSWORD_MIN_LENGTH` in `apps/api/src/modules/identity/password.ts`. */
const MIN_PASSWORD = 8;
const MAX_NAME = 190;
const MAX_EMAIL = 254;

type SignUpField = 'displayName' | 'email' | 'password' | 'organizationName';
const FIELDS: readonly SignUpField[] = ['displayName', 'email', 'password', 'organizationName'];

type Availability = 'checking' | 'available' | 'unavailable' | 'failed';

export interface SignUpScreenProps {
  client?: ApiClient;
  /** Called with the new workspace's slug once signed in. Default: full navigation there. */
  onCompleted?: (organizationSlug: string) => void;
  boundary?: AuthBoundary;
  /** Rendered under the form's intro — the "Continue with Google" button when configured. */
  alternatives?: ReactNode;
}

/**
 * **Sign up.** Public self-service account creation: name, email, password and a workspace
 * name create the person and a new organization they own, and sign them in.
 *
 * The layout is first-owner setup's (`FirstOwnerSetupScreen`) — the same identity shell, fields
 * and button — with the setup token, web link, timezone and language removed: the API derives
 * the web link from the workspace name and the timezone/language come from the browser. After
 * success the screen does what setup does: remember the CSRF token, announce `signed-in`, and
 * navigate to the new workspace (its My day / onboarding).
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
  const locale = useActiveLocale();

  const [availability, setAvailability] = useState<Availability>('checking');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [accountExists, setAccountExists] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SignUpField, string>>>({});

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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(undefined);
    setAccountExists(false);
    setFieldErrors({});

    const missing: Partial<Record<SignUpField, string>> = {};
    if (displayName.trim() === '') missing.displayName = t('signUp.missingName');
    if (email.trim() === '') missing.email = t('signUp.missingEmail');
    if (password.length < MIN_PASSWORD) missing.password = t('signUp.shortPassword');
    if (organizationName.trim() === '') missing.organizationName = t('signUp.missingWorkspace');
    if (Object.keys(missing).length > 0) {
      setFieldErrors(missing);
      setFailure(t('signUp.fieldsNeedAttention'));
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
      });
      setPassword('');
      api.rememberCsrfToken(outcome.csrfToken);
      boundary.announce('signed-in');
      if (onCompleted) onCompleted(outcome.organizationSlug);
      else window.location.assign(`/${encodeURIComponent(outcome.organizationSlug)}`);
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
        for (const field of FIELDS) {
          const message = byField.get(field);
          if (message !== undefined) next[field] = message;
        }
        setFieldErrors(next);
      }
      setFailure(describe(error, t));
    } finally {
      setSubmitting(false);
    }
  }

  const footer = (
    <>
      <Link href="/legal/privacy">Privacy</Link>
      <Link href="/legal/terms">Terms</Link>
      <Link href="/support">Support</Link>
    </>
  );

  if (availability === 'unavailable') {
    return (
      <IdentityShell screenId="ID-00" eyebrow={t('signUp.eyebrow')} footer={footer}>
        <div className="tm-id-intro">
          <h1 className="tm-identity__title">{t('signUp.unavailableTitle')}</h1>
          <p className="tm-id-lede">
            {t('signUp.unavailableBody')} <Link href="/sign-in">{t('signUp.signIn')}</Link>
          </p>
        </div>
      </IdentityShell>
    );
  }

  return (
    <IdentityShell screenId="ID-00" eyebrow={t('signUp.eyebrow')} footer={footer}>
      <div className="tm-id-intro">
        <h1 className="tm-identity__title">{t('signUp.title')}</h1>
        <p className="tm-id-lede">{t('signUp.lede')}</p>
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
          {alternatives}
          <form className="tm-stack tm-stack--loose" noValidate onSubmit={submit}>
            <fieldset className="tm-fieldset tm-stack" disabled={!hydrated || submitting}>
              <Field
                label={t('signUp.name')}
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
                label={t('signUp.email')}
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
                label={t('signUp.password')}
                type="password"
                name="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  clearFieldError('password');
                }}
                hint={t('signUp.passwordHint')}
                required
                {...errorProp(fieldErrors.password)}
              />
              <Field
                label={t('signUp.workspace')}
                name="organizationName"
                maxLength={MAX_NAME}
                value={organizationName}
                onChange={(event) => {
                  setOrganizationName(event.target.value);
                  clearFieldError('organizationName');
                }}
                hint={t('signUp.workspaceHint')}
                required
                {...errorProp(fieldErrors.organizationName)}
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

            <div className="tm-id-action-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={submitting}
                loadingLabel={t('signUp.submitting')}
                disabled={!hydrated}
              >
                {t('signUp.submit')}
              </Button>
            </div>
          </form>
        </>
      ) : null}

      <p className="tm-id-lede">
        {t('signUp.haveAccount')} <Link href="/sign-in">{t('signUp.signIn')}</Link>
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
