'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { useT } from '../../lib/i18n/use-t';
import { browserApiClient } from '../../lib/api/browser-client';
import { completeFirstOwnerSetup, fetchSetupAvailability } from '../../lib/api/setup';
import { ApiRequestError } from '../../lib/api/errors';
import { describeApiError, OFFLINE_LINES, type TranslateOr } from '../../lib/api/describe-error';
import { useTOr } from '../../lib/i18n/use-t-or';
import type { ApiClient } from '../../lib/api/client';
import { authBoundary, type AuthBoundary } from '../../lib/auth-boundary';
import {
  MAX_ORGANIZATION_NAME_LENGTH,
  MAX_SLUG_LENGTH,
  describeSlugProblems,
  slugProblems,
  slugify,
  WORKSPACE_LINK_LABEL,
  workspaceLinkHint,
} from '../../lib/slug';
import { useHydrated } from '../../lib/use-hydrated';
import '../../styles/screens/identity.css';

/** The password floor the API enforces; checked here too so the common mistake costs no attempt. */
const MIN_PASSWORD = 8;
const MAX_NAME = 200;
const MAX_EMAIL = 254;

/** The same two locales `CreateOrganizationScreen` offers — nothing else is translated yet. */
const LOCALES = [
  { value: 'en', label: 'English' },
  { value: 'ar', label: 'العربية' },
] as const;

/** The request fields a 400/409/422 can name, in the order the form shows them. */
type SetupField =
  | 'setupToken'
  | 'displayName'
  | 'email'
  | 'password'
  | 'organizationName'
  | 'slug'
  | 'timezone'
  | 'defaultLocale';

const SETUP_FIELDS: readonly SetupField[] = [
  'setupToken',
  'displayName',
  'email',
  'password',
  'organizationName',
  'slug',
  'timezone',
  'defaultLocale',
];

type Availability = 'checking' | 'available' | 'unavailable' | 'failed';

export interface FirstOwnerSetupScreenProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /**
   * Called with the new organization's slug once the owner is signed in. Injected in tests so
   * navigation can be asserted without a router; the default is a full navigation to
   * `/${slug}`, which also starts the new principal on an empty client cache.
   */
  onCompleted?: (organizationSlug: string) => void;
  /** Injected in tests. Defaults to the application's boundary. */
  boundary?: AuthBoundary;
}

/**
 * **First-owner setup.** How a fresh production install gets its first organisation owner.
 *
 * There is no public sign-up, so on an empty database nobody can sign in and nobody can invite.
 * The API opens `/public/setup` only while `SETUP_TOKEN` is configured *and* no organisation
 * exists; otherwise it answers 404, and this screen shows one plain "not available" message for
 * both cases — it does not say which, because "configured but already done" and "never
 * configured" are things a stranger has no business learning.
 *
 * The setup token is a secret. It lives in React state for as long as the form is open, is sent
 * only in the POST body, is never written to a URL or to browser storage, and is dropped from
 * state the moment the request has been answered with success.
 *
 * After success the API has already set the session cookies. This screen does what `SignInScreen`
 * does with an authenticated response: remember the CSRF token on the client, announce the
 * `signed-in` boundary so no previous principal's cache survives, and navigate — here, to the new
 * organization.
 */
export function FirstOwnerSetupScreen({
  client,
  onCompleted,
  boundary = authBoundary,
}: FirstOwnerSetupScreenProps) {
  const t = useT();
  const tOr = useTOr();
  const api = client ?? browserApiClient();
  const hydrated = useHydrated();

  const [availability, setAvailability] = useState<Availability>('checking');

  const [setupToken, setSetupToken] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [timezone, setTimezone] = useState(() => guessTimezone());
  const [locale, setLocale] = useState<string>(LOCALES[0].value);

  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SetupField, string>>>({});

  useEffect(() => {
    let cancelled = false;
    fetchSetupAvailability(api)
      .then((open) => {
        if (!cancelled) setAvailability(open ? 'available' : 'unavailable');
      })
      .catch(() => {
        if (!cancelled) setAvailability('failed');
      });
    return () => {
      cancelled = true;
    };
    // The client is stable for the life of the screen; re-checking on every render is not wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const effectiveSlug = slugEdited ? slug : slugify(organizationName);
  const localSlugError =
    organizationName === '' && !slugEdited
      ? undefined
      : describeSlugProblems(slugProblems(effectiveSlug));
  const slugError = localSlugError ?? fieldErrors.slug;

  function clearFieldError(field: SetupField) {
    setFailure(undefined);
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
    setFieldErrors({});

    const trimmedName = displayName.trim();
    const trimmedEmail = email.trim();
    const trimmedOrganization = organizationName.trim();

    const missing: Partial<Record<SetupField, string>> = {};
    if (setupToken === '') missing.setupToken = t('FirstOwnerSetupScreen.missingSetupToken');
    if (trimmedName === '') missing.displayName = t('FirstOwnerSetupScreen.missingName');
    if (trimmedEmail === '') missing.email = t('FirstOwnerSetupScreen.missingEmail');
    if (password.length < MIN_PASSWORD) missing.password = t('FirstOwnerSetupScreen.shortPassword');
    if (trimmedOrganization === '')
      missing.organizationName = t('FirstOwnerSetupScreen.missingOrganization');
    if (Object.keys(missing).length > 0) {
      setFieldErrors(missing);
      setFailure(t('FirstOwnerSetupScreen.fieldsNeedAttention'));
      return;
    }
    if (localSlugError !== undefined || effectiveSlug === '') {
      setFailure(t('FirstOwnerSetupScreen.fixWorkspaceLink'));
      return;
    }

    setSubmitting(true);
    try {
      const outcome = await completeFirstOwnerSetup(api, {
        setupToken,
        email: trimmedEmail,
        displayName: trimmedName,
        password,
        organizationName: trimmedOrganization,
        slug: effectiveSlug,
        timezone,
        defaultLocale: locale,
      });
      // Secrets are dropped the moment they are no longer needed — see `SignInScreen`.
      setSetupToken('');
      setPassword('');
      api.rememberCsrfToken(outcome.csrfToken);
      boundary.announce('signed-in');
      if (onCompleted) onCompleted(outcome.organizationSlug);
      // Land on the organization's home, not on `/${slug}` — that bare path has no page and
      // answered "We couldn't find that page" right after a successful setup (ACC-03).
      else window.location.assign(`/${encodeURIComponent(outcome.organizationSlug)}/home`);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        // Setup closed between the check and the submit (or someone else finished it first).
        setAvailability('unavailable');
        setSetupToken('');
        setPassword('');
        return;
      }
      // The API answers field problems as 422 `validation_failed` (400 for a malformed body) and
      // a taken email as 409 on the `email` field; all three can name fields.
      if (error instanceof ApiRequestError && [400, 409, 422].includes(error.status)) {
        const byField = error.fieldErrors();
        const next: Partial<Record<SetupField, string>> = {};
        for (const field of SETUP_FIELDS) {
          const message = byField.get(field);
          if (message !== undefined) next[field] = message;
        }
        setFieldErrors(next);
      }
      setFailure(describe(error, tOr));
    } finally {
      setSubmitting(false);
    }
  }

  const footer = (
    <>
      <Link href="/legal/privacy">{t('FirstOwnerSetupScreen.privacy')}</Link>
      {/* `/support` is not a published route (ACC-13); Contact is the live page. */}
      <Link href="/contact">{t('FirstOwnerSetupScreen.support')}</Link>
    </>
  );

  if (availability === 'unavailable') {
    return (
      <IdentityShell screenId="Setup" eyebrow={t('FirstOwnerSetupScreen.eyebrow')} footer={footer}>
        <div className="tm-id-intro">
          <h1 className="tm-identity__title">{t('FirstOwnerSetupScreen.unavailableTitle')}</h1>
          <p className="tm-id-lede">
            {t('FirstOwnerSetupScreen.unavailablePrefix')}{' '}
            <Link href="/sign-in">{t('FirstOwnerSetupScreen.unavailableSignIn')}</Link>
            {t('FirstOwnerSetupScreen.unavailableSuffix')}
          </p>
        </div>
      </IdentityShell>
    );
  }

  return (
    <IdentityShell screenId="Setup" eyebrow={t('FirstOwnerSetupScreen.eyebrow')} footer={footer}>
      <div className="tm-id-intro">
        <h1 className="tm-identity__title">{t('FirstOwnerSetupScreen.title')}</h1>
        <p className="tm-id-lede">{t('FirstOwnerSetupScreen.lede')}</p>
      </div>

      {availability === 'checking' ? (
        <InlineAlert tone="neutral" live>
          {t('FirstOwnerSetupScreen.checking')}
        </InlineAlert>
      ) : null}

      {availability === 'failed' ? (
        <InlineAlert tone="danger" title={t('FirstOwnerSetupScreen.checkFailedTitle')} live>
          {t('FirstOwnerSetupScreen.checkFailedBody')}
        </InlineAlert>
      ) : null}

      {availability === 'available' ? (
        <form className="tm-stack tm-stack--loose" noValidate onSubmit={submit}>
          <fieldset className="tm-fieldset tm-stack" disabled={!hydrated || submitting}>
            <Field
              label={t('FirstOwnerSetupScreen.setupTokenLabel')}
              type="password"
              name="setupToken"
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              value={setupToken}
              onChange={(event) => {
                setSetupToken(event.target.value);
                clearFieldError('setupToken');
              }}
              required
              {...errorProp(fieldErrors.setupToken)}
            />
            <Field
              label={t('FirstOwnerSetupScreen.nameLabel')}
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
              label={t('FirstOwnerSetupScreen.emailLabel')}
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
              label={t('FirstOwnerSetupScreen.passwordLabel')}
              type="password"
              name="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                clearFieldError('password');
              }}
              hint={t('FirstOwnerSetupScreen.passwordHint')}
              required
              {...errorProp(fieldErrors.password)}
            />
          </fieldset>

          <fieldset className="tm-fieldset tm-stack" disabled={!hydrated || submitting}>
            <legend className="tm-field__label">{t('FirstOwnerSetupScreen.orgLegend')}</legend>
            <Field
              label={t('FirstOwnerSetupScreen.orgNameLabel')}
              name="organizationName"
              maxLength={MAX_ORGANIZATION_NAME_LENGTH}
              value={organizationName}
              onChange={(event) => {
                setOrganizationName(event.target.value);
                clearFieldError('organizationName');
                if (!slugEdited) clearFieldError('slug');
              }}
              hint={t('FirstOwnerSetupScreen.orgNameHint')}
              required
              {...errorProp(fieldErrors.organizationName)}
            />
            <Field
              label={WORKSPACE_LINK_LABEL}
              name="slug"
              maxLength={MAX_SLUG_LENGTH}
              value={effectiveSlug}
              onChange={(event) => {
                setSlugEdited(true);
                setSlug(event.target.value);
                clearFieldError('slug');
              }}
              dir="ltr"
              spellCheck={false}
              hint={workspaceLinkHint(hydrated ? window.location.host : '', effectiveSlug)}
              {...errorProp(slugError)}
            />

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-setup-timezone">
                {t('FirstOwnerSetupScreen.timezoneLabel')}
              </label>
              <select
                id="tm-setup-timezone"
                name="timezone"
                className="tm-field__control"
                value={timezone}
                onChange={(event) => {
                  setTimezone(event.target.value);
                  clearFieldError('timezone');
                }}
                aria-invalid={fieldErrors.timezone ? true : undefined}
                aria-describedby={fieldErrors.timezone ? 'tm-setup-timezone-error' : undefined}
              >
                {timezoneOptions(timezone).map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
              {fieldErrors.timezone ? (
                <span className="tm-field__error" id="tm-setup-timezone-error">
                  {fieldErrors.timezone}
                </span>
              ) : null}
            </div>

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-setup-locale">
                {t('FirstOwnerSetupScreen.languageLabel')}
              </label>
              <select
                id="tm-setup-locale"
                name="defaultLocale"
                className="tm-field__control"
                value={locale}
                onChange={(event) => {
                  setLocale(event.target.value);
                  clearFieldError('defaultLocale');
                }}
                aria-invalid={fieldErrors.defaultLocale ? true : undefined}
                aria-describedby={fieldErrors.defaultLocale ? 'tm-setup-locale-error' : undefined}
              >
                {LOCALES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {fieldErrors.defaultLocale ? (
                <span className="tm-field__error" id="tm-setup-locale-error">
                  {fieldErrors.defaultLocale}
                </span>
              ) : null}
            </div>
          </fieldset>

          {failure ? (
            <InlineAlert tone="danger" title={t('FirstOwnerSetupScreen.createErrorTitle')} live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={submitting}
              loadingLabel={t('FirstOwnerSetupScreen.creating')}
              disabled={!hydrated}
            >
              {t('FirstOwnerSetupScreen.submit')}
            </Button>
          </div>
        </form>
      ) : null}
    </IdentityShell>
  );
}

/** `exactOptionalPropertyTypes`: pass `error` only when there is one. */
function errorProp(message: string | undefined): { error?: string } {
  return message === undefined ? {} : { error: message };
}

/**
 * Turn a thrown value into a sentence. 401 and 429 get fixed wording; 409 and 400 render the
 * API's message, which names the conflict or the shape problem and carries no stored data.
 */
function describe(error: unknown, tOr: TranslateOr): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401)
      return tOr('FirstOwnerSetup.tokenWrong', 'That setup token is not correct.');
    if (error.status === 429) {
      return tOr(
        'FirstOwnerSetup.tooManyAttempts',
        'Too many attempts. Wait a few minutes and try again.',
      );
    }
  }
  return describeApiError(error, tOr, OFFLINE_LINES);
}

/** Every zone the runtime knows, always including the current choice. */
function timezoneOptions(current: string): readonly string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  let zones: string[] = ['UTC', 'Africa/Cairo', 'Europe/London', 'America/New_York', 'Asia/Dubai'];
  if (typeof intl.supportedValuesOf === 'function') {
    try {
      zones = intl.supportedValuesOf('timeZone');
    } catch {
      // keep the fallback
    }
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

/** The browser's timezone where it is known, `UTC` where it is not. */
function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
