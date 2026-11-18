'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from '../website/WebLink';
import { Badge, Button, Field, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchSignupAvailability, signUp } from '../../lib/api/sign-up';
import { afterSignUpPath, planFromQuery } from '../../lib/api/plan-versions';
import { referralCodeFromQuery } from '../../lib/api/referrals';
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
import { suggestWorkspaceName } from '../../lib/workspace-name-suggestion';
import { useImportToolHref } from '../../lib/use-import-tool-href';
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
/** Enough to catch a typo (`omar@northstar`); the API is the real check. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type SignUpField = 'displayName' | 'email' | 'password' | 'organizationName';
const API_FIELDS: readonly SignUpField[] = ['displayName', 'email', 'password', 'organizationName'];

type Availability = 'checking' | 'available' | 'unavailable' | 'failed';
type Step = 'email' | 'details';
/** Step 1's own refusals: the e-mail's shape, or the API's "this account exists" answer. */
type EmailProblem = 'missing' | 'invalid' | 'exists';

/** What the check-your-email state needs once the workspace exists. */
interface Created {
  readonly email: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  /** PLANWEB: the plan the API accepted from the pricing page's `?plan=`, or `null`. */
  readonly planId: string | null;
}

/** The button row of the frame: the button at its own width, not stretched. */
const ACTION_ROW = { display: 'flex', alignItems: 'center', gap: 'var(--s5)' } as const;

export interface SignUpScreenProps {
  client?: ApiClient;
  /**
   * Called with the new workspace's slug (and the plan the API accepted from `?plan=`, or `null`)
   * when the person leaves the check-your-email state. Default: full navigation to its home, or to
   * the plan-change preview for an accepted paid plan.
   */
  onCompleted?: (organizationSlug: string, planId: string | null) => void;
  boundary?: AuthBoundary;
  /** Rendered above the form — the "Continue with Google" button when configured. */
  alternatives?: ReactNode;
  /**
   * The waits before the automatic retries of the page's one required load (is sign-up open?).
   * Default: two retries, 0.6 s then 1.5 s. Tests pass zeros.
   */
  retryDelaysMs?: readonly number[];
}

const RETRY_DELAYS_MS: readonly number[] = [600, 1500];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * **Start free** (`/sign-up`), the two-step "Sign-up funnel" (Figma 652:13273, SIGNUP2).
 *
 * Step 1 asks for the e-mail only (or Google); step 2 for the name, the workspace name (suggested
 * from the e-mail, `lib/workspace-name-suggestion.ts`) and the password. The steps are client
 * state on one route: nothing is sent until "Create my workspace", which makes the one existing
 * `lib/api/sign-up.ts` call. There is no "does this e-mail exist" lookup at step 1 (it would let
 * anyone test who has an account): "You already have an account" appears only when that final
 * answer is a 409, and then on step 1, where the e-mail is. Terms are accepted by the explicit
 * "By continuing you agree" line (the API takes no acceptance field). With the API's
 * `PUBLIC_SIGNUP` switch off (404) the screen says sign-up is not open and shows no form.
 */
export function SignUpScreen({
  client,
  onCompleted,
  boundary = authBoundary,
  alternatives,
  retryDelaysMs = RETRY_DELAYS_MS,
}: SignUpScreenProps) {
  const api = client ?? browserApiClient();
  const hydrated = useHydrated();
  const t = useT();
  const g = (key: GettingInKey) => gettingIn(t, key);
  const locale = useActiveLocale();
  /** "Sign in instead" keeps a "switch from X" visitor's `?import=<tool>` (allow-listed). */
  const signInHref = useImportToolHref('/sign-in');

  const [availability, setAvailability] = useState<Availability>('checking');
  /** Bumped by "Try again": re-runs the load (and the form proof) without a page reload. */
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadNotice = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>('email');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [emailProblem, setEmailProblem] = useState<EmailProblem | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [organizationName, setOrganizationName] = useState('');
  /** Once the person types a workspace name, the suggestion stops following theirs. */
  const [organizationTouched, setOrganizationTouched] = useState(false);
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SignUpField, string>>>({});
  const [created, setCreated] = useState<Created | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const stepChanged = useRef(false);
  const google = useGoogleAvailability(api);
  const [googleError, setGoogleError] = useState<MessageKey | undefined>(undefined);
  // 52-21: the invisible form proof, fetched once when the form is shown.
  const formProof = useFormProof(api, loadAttempt);
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
  /** PLANWEB: the pricing page's `?plan=` (a catalog id only), sent with the sign-up. */
  const [pickedPlan, setPickedPlan] = useState<string | null>(null);
  /** REFERRAL (57-08): an invite link's `?ref=` code, sent with the sign-up (shape-checked). */
  const [referralCode, setReferralCode] = useState<string | null>(null);
  useEffect(() => {
    setGoogleError(googleErrorKey(window.location.search));
    setMicrosoftError(microsoftErrorOf(window.location.search));
    setPickedPlan(planFromQuery(new URLSearchParams(window.location.search).get('plan')));
    setReferralCode(referralCodeFromQuery(new URLSearchParams(window.location.search).get('ref')));
  }, []);

  // SIGNUP3: the one required load. A weak connection gets two quiet retries, then a calm
  // "didn't load" notice with Try again; nothing was submitted, so it is never a sign-up error.
  useEffect(() => {
    let cancelled = false;
    setAvailability('checking');
    void (async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const open = await fetchSignupAvailability(api);
          if (!cancelled) setAvailability(open ? 'available' : 'unavailable');
          return;
        } catch {
          const delay = retryDelaysMs[attempt];
          if (delay === undefined) break;
          await wait(delay);
          if (cancelled) return;
        }
      }
      if (!cancelled) setAvailability('failed');
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAttempt]);

  useEffect(() => {
    if (availability === 'failed') loadNotice.current?.focus();
  }, [availability]);

  // Focus follows the step: the new step's heading, so a screen reader starts at its top.
  useEffect(() => {
    if (!stepChanged.current) return;
    heading.current?.focus();
  }, [step]);

  function goTo(next: Step) {
    stepChanged.current = true;
    setFailure(undefined);
    setStep(next);
  }

  function clearFieldError(field: SignUpField) {
    setFailure(undefined);
    setFieldErrors((current) => {
      if (current[field] === undefined) return current;
      const rest = { ...current };
      delete rest[field];
      return rest;
    });
  }

  function complete(organizationSlug: string, planId: string | null) {
    if (onCompleted) onCompleted(organizationSlug, planId);
    else window.location.assign(afterSignUpPath(organizationSlug, planId));
  }

  function continueWithEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = email.trim();
    if (typed === '') {
      setEmailProblem('missing');
      return;
    }
    if (typed.length > MAX_EMAIL || !EMAIL_SHAPE.test(typed)) {
      setEmailProblem('invalid');
      return;
    }
    setEmailProblem(undefined);
    if (!organizationTouched) setOrganizationName(suggestWorkspaceName(typed, displayName));
    goTo('details');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(undefined);
    setFieldErrors({});

    const missing: Partial<Record<SignUpField, string>> = {};
    if (displayName.trim() === '') missing.displayName = g('GettingIn.nameMissing');
    if (organizationName.trim() === '') missing.organizationName = t('signUp.missingWorkspace');
    if (password.length < GETTING_IN_MIN_PASSWORD) missing.password = g('GettingIn.passwordShort');
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
        // The page's own language (ar-EG on /ar): the new account and workspace open in it.
        defaultLocale: locale,
        website,
        ...(pickedPlan === null ? {} : { plan: pickedPlan }),
        ...(referralCode === null ? {} : { referral: referralCode }),
        ...(await formProof.fields()),
      });
      setPassword('');
      api.rememberCsrfToken(outcome.csrfToken);
      boundary.announce('signed-in');
      setCreated({
        email: email.trim(),
        organizationName: organizationName.trim(),
        organizationSlug: outcome.organizationSlug,
        planId: outcome.planId ?? null,
      });
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        setAvailability('unavailable');
        setPassword('');
        return;
      }
      if (error instanceof ApiRequestError && error.status === 409) {
        // The one place "you already have an account" can come from: the sign-up answer itself.
        setPassword('');
        setEmailProblem('exists');
        goTo('email');
        return;
      }
      if (error instanceof ApiRequestError && [400, 422].includes(error.status)) {
        const byField = error.fieldErrors();
        if (byField.get('email') !== undefined) {
          setEmailProblem('invalid');
          goTo('email');
          return;
        }
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
            <Link className="tm-id-link" href={signInHref}>
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
          <Button
            tone="lime"
            size="accessible"
            onClick={() => complete(created.organizationSlug, created.planId)}
          >
            {g('GettingIn.openWorkspace')}
          </Button>
        </div>
      </IdentityShell>
    );
  }

  const providers = google?.signUp === true || microsoft?.signUp === true;

  if (availability === 'available' && step === 'details') {
    return (
      <IdentityShell brand={false}>
        <div className="tm-id-intro">
          <div className="tm-id-steps">
            <p className="tm-id-steps__label">
              {fill(t('SignUpFunnel.stepOf'), { current: '2', total: '2' })}
            </p>
            <span className="tm-id-steps__bar" aria-hidden="true" />
            <span className="tm-id-steps__bar" aria-hidden="true" />
          </div>
          <h1 ref={heading} tabIndex={-1} className="tm-identity__title">
            {t('SignUpFunnel.almostTitle')}
          </h1>
          <p className="tm-id-lede">
            {t('SignUpFunnel.signedUpAs')
              .split(/(\{email\})/)
              .map((part, index) =>
                part === '{email}' ? (
                  <bdi key={index} dir="ltr">
                    {email.trim()}
                  </bdi>
                ) : (
                  part
                ),
              )}
          </p>
        </div>

        <form className="tm-stack tm-stack--loose" noValidate onSubmit={submit}>
          <fieldset className="tm-fieldset tm-stack" disabled={!hydrated || submitting}>
            <Field
              label={g('GettingIn.fullName')}
              name="displayName"
              autoComplete="name"
              maxLength={MAX_NAME}
              value={displayName}
              onChange={(event) => {
                const value = event.target.value;
                setDisplayName(value);
                if (!organizationTouched) setOrganizationName(suggestWorkspaceName(email, value));
                clearFieldError('displayName');
              }}
              required
              {...errorProp(fieldErrors.displayName)}
            />
            <Field
              label={t('SignUpFunnel.workspaceName')}
              name="organizationName"
              autoComplete="organization"
              maxLength={MAX_NAME}
              value={organizationName}
              onChange={(event) => {
                setOrganizationName(event.target.value);
                setOrganizationTouched(true);
                clearFieldError('organizationName');
              }}
              hint={t('SignUpFunnel.workspaceHint')}
              required
              {...errorProp(fieldErrors.organizationName)}
            />
            <div className="tm-id-password">
              <Field
                label={g('GettingIn.password')}
                type={showPassword ? 'text' : 'password'}
                name="password"
                autoComplete="new-password"
                minLength={GETTING_IN_MIN_PASSWORD}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  clearFieldError('password');
                }}
                hint={t('SignUpFunnel.passwordHint')}
                required
                {...errorProp(fieldErrors.password)}
              />
              <button
                type="button"
                className="tm-id-password__toggle"
                aria-pressed={showPassword}
                aria-label={t(
                  showPassword ? 'SignUpFunnel.hidePassword' : 'SignUpFunnel.showPassword',
                )}
                onClick={() => setShowPassword((shown) => !shown)}
              >
                {t(showPassword ? 'SignUpFunnel.hide' : 'SignUpFunnel.show')}
              </button>
            </div>
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
            </InlineAlert>
          ) : null}

          <Button
            type="submit"
            tone="lime"
            size="accessible"
            className="tm-id-wide"
            loading={submitting}
            loadingLabel={g('GettingIn.creatingWorkspace')}
            disabled={!hydrated}
          >
            {g('GettingIn.createWorkspace')}
          </Button>
        </form>

        <div>
          <Button
            type="button"
            tone="text"
            size="accessible"
            className="tm-id-back"
            onClick={() => goTo('email')}
            disabled={submitting}
          >
            <span className="tm-id-back__arrow" aria-hidden="true">
              ←
            </span>
            {t('SignUpFunnel.back')}
          </Button>
        </div>
      </IdentityShell>
    );
  }

  const emailAlert =
    emailProblem === 'exists' ? (
      <InlineAlert tone="danger" title={t('SignUpFunnel.existsTitle')} live>
        {t('SignUpFunnel.existsBody')}
      </InlineAlert>
    ) : emailProblem !== undefined ? (
      <InlineAlert tone="danger" title={t('SignUpFunnel.emailInvalidTitle')} live>
        {t(emailProblem === 'missing' ? 'SignUpFunnel.emailMissing' : 'SignUpFunnel.emailInvalid')}
      </InlineAlert>
    ) : null;

  return (
    <IdentityShell brand={false}>
      <div className="tm-id-intro">
        <p>
          <Badge>{t('SignUpFunnel.badge')}</Badge>
        </p>
        <h1 ref={heading} tabIndex={-1} className="tm-identity__title">
          {t('SignUpFunnel.title')}
        </h1>
        <p className="tm-id-lede">{t('SignUpFunnel.lede')}</p>
      </div>

      {availability === 'checking' ? (
        <InlineAlert tone="neutral" live>
          {t('signUp.checking')}
        </InlineAlert>
      ) : null}

      {availability === 'failed' ? (
        <div ref={loadNotice} tabIndex={-1} className="tm-stack tm-id-load-failed">
          <InlineAlert tone="neutral" live>
            {t('SignUpFunnel.loadFailed')}
          </InlineAlert>
          <Button
            type="button"
            tone="lime"
            size="accessible"
            className="tm-id-wide"
            onClick={() => setLoadAttempt((n) => n + 1)}
          >
            {t('SignUpFunnel.tryAgain')}
          </Button>
        </div>
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
          {!inAppBrowser.inApp && providers ? (
            <>
              <div className="tm-id-methods">
                {google?.signUp ? <GoogleSignInButton api={api} input={signUpInput} /> : null}
                {microsoft?.signUp ? <MicrosoftSignInButton api={api} input={signUpInput} /> : null}
              </div>
              <p className="tm-divider tm-id-or">{t('SignUpFunnel.or')}</p>
            </>
          ) : null}
          <form className="tm-stack" noValidate onSubmit={continueWithEmail}>
            <fieldset className="tm-fieldset tm-stack" disabled={!hydrated}>
              <Field
                className="tm-id-quiet-error"
                label={t('SignUpFunnel.email')}
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                dir="ltr"
                maxLength={MAX_EMAIL}
                placeholder={t('SignUpFunnel.emailPlaceholder')}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setEmailProblem(undefined);
                  clearFieldError('email');
                }}
                required
                // The card below says it in full; the field's own line is for the screen reader.
                {...errorProp(
                  emailProblem === undefined
                    ? undefined
                    : t(
                        emailProblem === 'exists'
                          ? 'SignUpFunnel.existsBody'
                          : emailProblem === 'missing'
                            ? 'SignUpFunnel.emailMissing'
                            : 'SignUpFunnel.emailInvalid',
                      ),
                )}
              />
            </fieldset>
            {emailAlert}
            {emailProblem === 'exists' ? (
              <Link
                className="tm-button tm-button--lime tm-button--accessible tm-id-wide"
                href={signInHref}
              >
                {t('signUp.signIn')}
              </Link>
            ) : (
              <Button
                type="submit"
                tone="lime"
                size="accessible"
                className="tm-id-wide"
                disabled={!hydrated}
              >
                {t('SignUpFunnel.continue')}
              </Button>
            )}
          </form>
          {inAppBrowser.inApp && providers ? (
            <>
              <p className="tm-divider tm-id-or">{t('SignUpFunnel.or')}</p>
              <InAppBrowserNotice
                google={google?.signUp === true}
                microsoft={microsoft?.signUp === true}
                android={inAppBrowser.android}
              />
            </>
          ) : null}
          <p className="tm-id-terms">
            <TermsLine template={t('SignUpFunnel.terms')} t={t} />
          </p>
        </>
      ) : null}

      <p className="tm-id-lede">
        {t('signUp.haveAccount')}{' '}
        <Link className="tm-id-link" href={signInHref}>
          {t('signUp.signIn')}
        </Link>
      </p>
    </IdentityShell>
  );
}

/** "By continuing you agree to the {terms} and the {privacy}." with the two links in place. */
function TermsLine({ template, t }: { template: string; t: (key: MessageKey) => string }) {
  return (
    <>
      {template.split(/(\{terms\}|\{privacy\})/).map((part, index) =>
        part === '{terms}' ? (
          <Link key={index} className="tm-id-link" href="/legal/terms">
            {t('SignUpFunnel.termsLink')}
          </Link>
        ) : part === '{privacy}' ? (
          <Link key={index} className="tm-id-link" href="/legal/privacy">
            {t('SignUpFunnel.privacyLink')}
          </Link>
        ) : (
          part
        ),
      )}
    </>
  );
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
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
