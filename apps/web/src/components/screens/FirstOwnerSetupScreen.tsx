'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { completeFirstOwnerSetup, fetchSetupAvailability } from '../../lib/api/setup';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { authBoundary, type AuthBoundary } from '../../lib/auth-boundary';
import {
  MAX_ORGANIZATION_NAME_LENGTH,
  MAX_SLUG_LENGTH,
  describeSlugProblems,
  slugProblems,
  slugify,
} from '../../lib/slug';
import { useHydrated } from '../../lib/use-hydrated';

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
    if (setupToken === '') missing.setupToken = 'Enter the setup token.';
    if (trimmedName === '') missing.displayName = 'Enter your name.';
    if (trimmedEmail === '') missing.email = 'Enter your email.';
    if (password.length < MIN_PASSWORD)
      missing.password = `Use at least ${MIN_PASSWORD} characters.`;
    if (trimmedOrganization === '') missing.organizationName = 'Enter an organization name.';
    if (Object.keys(missing).length > 0) {
      setFieldErrors(missing);
      setFailure('Some fields need attention.');
      return;
    }
    if (localSlugError !== undefined || effectiveSlug === '') {
      setFailure('Fix the workspace address first.');
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
      else window.location.assign(`/${encodeURIComponent(outcome.organizationSlug)}`);
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
      setFailure(describe(error));
    } finally {
      setSubmitting(false);
    }
  }

  const footer = (
    <>
      <Link href="/legal/privacy">Privacy</Link>
      <Link href="/support">Support</Link>
    </>
  );

  if (availability === 'unavailable') {
    return (
      <IdentityShell screenId="Setup" eyebrow="Setup" footer={footer}>
        <div className="tm-stack tm-stack--tight">
          <h1 className="tm-identity__title">Setup is not available</h1>
          <p className="tm-prose">
            If you already have an account, <Link href="/sign-in">sign in</Link>.
          </p>
        </div>
      </IdentityShell>
    );
  }

  return (
    <IdentityShell screenId="Setup" eyebrow="Setup" footer={footer}>
      <div className="tm-stack tm-stack--tight">
        <h1 className="tm-identity__title">Create the owner account</h1>
        <p className="tm-prose">
          This sets up the first organization on this installation and signs you in as its owner.
          You need the setup token the person who installed TManage was given.
        </p>
      </div>

      {availability === 'checking' ? (
        <InlineAlert tone="neutral" live>
          Checking whether setup is open…
        </InlineAlert>
      ) : null}

      {availability === 'failed' ? (
        <InlineAlert tone="danger" title="Could not check setup" live>
          We could not reach the server. Reload the page to try again.
        </InlineAlert>
      ) : null}

      {availability === 'available' ? (
        <form className="tm-stack tm-stack--loose" noValidate onSubmit={submit}>
          <fieldset className="tm-fieldset tm-stack" disabled={!hydrated || submitting}>
            <Field
              label="Setup token"
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
              label="Your name"
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
              label="Email"
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
              label="Password"
              type="password"
              name="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                clearFieldError('password');
              }}
              hint={`At least ${MIN_PASSWORD} characters.`}
              required
              {...errorProp(fieldErrors.password)}
            />
          </fieldset>

          <fieldset className="tm-fieldset tm-stack" disabled={!hydrated || submitting}>
            <legend className="tm-field__label">Your organization</legend>
            <Field
              label="Organization name"
              name="organizationName"
              maxLength={MAX_ORGANIZATION_NAME_LENGTH}
              value={organizationName}
              onChange={(event) => {
                setOrganizationName(event.target.value);
                clearFieldError('organizationName');
                if (!slugEdited) clearFieldError('slug');
              }}
              hint="The name your team and your clients will see."
              required
              {...errorProp(fieldErrors.organizationName)}
            />
            <Field
              label="Workspace address"
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
              hint="Lowercase letters, numbers and hyphens. It appears in every link to this organization."
              {...errorProp(slugError)}
            />

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-setup-timezone">
                Timezone
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
                Language
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
            <InlineAlert tone="danger" title="Could not create the owner account" live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={submitting}
              loadingLabel="Creating"
              disabled={!hydrated}
            >
              Create owner account
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
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return 'That setup token is not correct.';
    if (error.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
    return error.message;
  }
  if (error instanceof NetworkError) return 'We could not reach the server. Please try again.';
  return 'Something went wrong. Please try again.';
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
