'use client';

import {
  useEffect,
  useId,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar, Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getLanguageAndTimezone,
  languageOfLocale,
  saveLanguageAndTimezone,
  type AppLanguage,
} from '../../lib/api/preferences';
import {
  type DisplayPreferencesView,
  type DisplayTimezone,
} from '../../lib/api/display-preferences';
import { fetchMyProfile, saveMyProfile, type MyProfileView } from '../../lib/api/member-profile';
import { changeMyPassword, listFactors } from '../../lib/api/auth';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { activeLocale } from '../../lib/i18n/locale-store';
import { TimeZoneSelect } from '../TimeZoneSelect';
import { PrivacyPrefs } from '../preferences/PrivacyPrefs';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import type { MessageKey } from '../../lib/i18n/t';
import '../../styles/screens/preferences.css';

export interface PreferencesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

// ── Shared pieces for the preference screens (PREF-01…05) ─────────────────────────────────────

/** The sections under the account orb, in PREF-01's "YOURS ONLY" order. */
export type PreferencesSection =
  | 'profile'
  | 'appearance'
  | 'notifications'
  | 'accessibility'
  | 'keyboard'
  | 'ai-assistant'
  // D5 (Figma F5 phone): the person's own data export and account deletion.
  | 'my-data'
  // 56-22 / R43 (Figma 575:32761): passkeys, devices and the security score.
  | 'sign-in-security';

const SECTIONS: readonly {
  id: PreferencesSection;
  labelKey: MessageKey;
  href: string;
  /** English until the key reaches the catalogs (i18n fragment). */
  fallback?: string;
}[] = [
  { id: 'profile', labelKey: 'PreferencesScreen.sectionProfile', href: '/preferences' },
  { id: 'appearance', labelKey: 'PreferencesScreen.sectionAppearance', href: '/settings/display' },
  {
    id: 'notifications',
    labelKey: 'PreferencesScreen.sectionNotifications',
    href: '/inbox/notification-preferences',
  },
  {
    id: 'accessibility',
    labelKey: 'PreferencesScreen.sectionAccessibility',
    href: '/settings/accessibility',
  },
  {
    id: 'keyboard',
    labelKey: 'PreferencesScreen.sectionKeyboard',
    href: '/preferences?section=keyboard',
  },
  // Every member's own keys, so it sits under the account orb, not under Control.
  {
    id: 'ai-assistant',
    labelKey: 'PreferencesScreen.sectionAiAssistant',
    href: '/settings/ai-assistant',
  },
  // D5 (Figma F5 phone): the key reaches the catalogs through the wave's i18n fragment.
  {
    id: 'my-data',
    labelKey: 'PreferencesScreen.sectionMyData' as string as MessageKey,
    href: '/settings/my-data',
  },
  {
    id: 'sign-in-security',
    labelKey: 'PreferencesScreen.sectionSignInSecurity',
    href: '/settings/sign-in-security',
    fallback: 'Sign-in security',
  },
];

/** PREF-01's left column: the person's own settings, one link per section. */
export function PreferencesNav({
  organizationSlug,
  current,
}: {
  organizationSlug: string;
  current: PreferencesSection;
}) {
  const headingId = useId();
  const t = useT();
  const tr = useTOr();
  return (
    <div>
      <h2 id={headingId} className="tm-prefs-nav__heading">
        {t('PreferencesScreen.yoursOnly')}
      </h2>
      <ul className="tm-prefs-nav" aria-labelledby={headingId}>
        {SECTIONS.map((section) => (
          <li key={section.id}>
            {/* No prefetch: seven sections fetched at once drew 503s from the shared host. */}
            <Link
              prefetch={false}
              href={`/${organizationSlug}${section.href}`}
              className="tm-prefs-nav__link"
              {...(section.id === current ? { 'aria-current': 'page' as const } : {})}
            >
              {section.fallback ? tr(section.labelKey, section.fallback) : t(section.labelKey)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One of the design's switch rows: label, an optional hint line, and the 44×26 switch at the end. */
export function PreferenceToggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const id = useId();
  return (
    <div className="tm-prefs-toggle">
      <span className="tm-prefs-toggle__text">
        <label className="tm-prefs-toggle__label" htmlFor={id}>
          {label}
        </label>
        {hint ? (
          <span className="tm-prefs-toggle__hint" id={`${id}-hint`}>
            {hint}
          </span>
        ) : null}
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="tm-prefs-switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={onChange}
      />
    </div>
  );
}

/** A mono-labelled 46px field around a native `<select>`. */
export function PreferenceSelect({
  label,
  name,
  value,
  onChange,
  children,
  wide,
}: {
  label: ReactNode;
  name?: string;
  value: string | number;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const id = useId();
  return (
    <div className={wide ? 'tm-prefs-field tm-prefs-field--wide' : 'tm-prefs-field'}>
      <label className="tm-prefs-field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        name={name}
        className="tm-prefs-field__control"
        value={value}
        onChange={onChange}
      >
        {children}
      </select>
    </div>
  );
}

// ── Profile & preferences (t2-b, Figma 371:1836 EN / 371:2264 AR) ─────────────────────────────

/**
 * The Profile.* keys this screen uses. They arrive in the catalogs with this slice's i18n fragment;
 * the union keeps every call site checked against the list here until then.
 */
type ProfileKey =
  | 'Profile.title'
  | 'Profile.loading'
  | 'Profile.fullName'
  | 'Profile.signInEmail'
  | 'Profile.signInEmailHint'
  | 'Profile.jobTitle'
  | 'Profile.profileLoadError'
  | 'Profile.languageHeading'
  | 'Profile.languageLead'
  | 'Profile.timeZone'
  | 'Profile.preferencesLoadError'
  | 'Profile.securityHeading'
  | 'Profile.twoStep'
  | 'Profile.twoStepHint'
  | 'Profile.on'
  | 'Profile.off'
  | 'Profile.turnOn'
  | 'Profile.manage'
  | 'Profile.password'
  | 'Profile.changePassword'
  | 'Profile.currentPassword'
  | 'Profile.currentPasswordHint'
  | 'Profile.currentPasswordRequired'
  | 'Profile.authenticatorCode'
  | 'Profile.passwordHint'
  | 'Profile.newPassword'
  | 'Profile.confirmPassword'
  | 'Profile.savePassword'
  | 'Profile.cancel'
  | 'Profile.passwordMismatch'
  | 'Profile.passwordSaved'
  | 'Profile.save'
  | 'Profile.saving'
  | 'Profile.saved'
  | 'Profile.couldNotSave'
  | 'Profile.networkError'
  | 'Profile.genericError'
  | 'Profile.freshSignInRequired';

type ProfileTranslate = (key: ProfileKey) => string;

/** Language names are endonyms — each in its own script — so they are not translated. */
const LANGUAGES: readonly { id: AppLanguage; label: string; lang: string }[] = [
  { id: 'en', label: 'English', lang: 'en' },
  { id: 'ar', label: 'العربية', lang: 'ar' },
];

const S = {
  card: {
    maxInlineSize: '720px',
    gap: 'var(--s5)',
    padding: 'var(--s10)',
  },
  photoRow: { display: 'flex', alignItems: 'center', gap: 'var(--s4)' },
  lead: { margin: 0, fontSize: 'var(--t-body-md)', color: 'var(--ink-650)' },
  fieldset: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--s4)',
    margin: 0,
    padding: 0,
    border: 0,
  },
  legend: {
    position: 'absolute',
    inlineSize: '1px',
    blockSize: '1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
  },
  readOnly: { background: 'var(--paper-150)', color: 'var(--ink-650)' },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--s4)',
    flexWrap: 'wrap',
  },
  rowText: { display: 'flex', flexDirection: 'column', gap: '2px', minInlineSize: 0 },
  rowLabel: { fontSize: 'var(--t-ui-sm)', fontWeight: 500, color: 'var(--ink-950)' },
  rowHint: { fontSize: 'var(--t-caption)', color: 'var(--ink-650)' },
  rowEnd: { display: 'flex', alignItems: 'center', gap: 'var(--s3)' },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--s2)',
    padding: '4px var(--s3)',
    border: 'var(--b-quiet) solid var(--ink-500)',
    borderRadius: 'var(--r-capsule)',
    fontSize: 'var(--t-caption)',
    color: 'var(--ink-800)',
  },
  pillMark: { inlineSize: '8px', blockSize: '8px', background: 'var(--ink-950)' },
  capsule: { minBlockSize: '48px', paddingInline: 'var(--s5)', fontSize: 'var(--t-body-md)' },
  footer: { display: 'flex', justifyContent: 'flex-end' },
  passwordForm: { display: 'flex', flexDirection: 'column', gap: 'var(--s3)' },
} satisfies Record<string, CSSProperties>;

/**
 * **Profile & preferences (t2-b)** — the page under the account orb.
 *
 * Three blocks on one card, as the frame draws them: the profile (initials orb, full name, the
 * read-only sign-in email an admin changes, job title) saved through `me/profile`; the one
 * app-wide language plus the time zone, saved through the display preferences and published to the
 * active-locale store on save, which flips `dir` for Arabic; and security — two-step sign-in read
 * from the enrolled factors with a link to its own page, and a password change. "Change photo" is
 * not drawn: there is no upload endpoint for it yet.
 */
export function PreferencesScreen({
  organizationSlug,
  organizationName,
  client,
}: PreferencesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const translate = useT();
  const t: ProfileTranslate = (key) => translate(key as MessageKey);
  const profileKey = ['me', 'profile', organizationSlug];
  // The same key the Appearance page and `ThemeSync` read, so the three never hold different copies
  // of the one display-preferences record (a stale copy here would send an old theme back on save).
  const prefsKey = ['display-preferences', organizationSlug];

  const profile = useQuery({
    queryKey: profileKey,
    queryFn: () => fetchMyProfile(api, organizationSlug),
    retry: false,
  });
  const prefs = useQuery({
    queryKey: prefsKey,
    queryFn: () => getLanguageAndTimezone(api, organizationSlug),
  });
  const factors = useQuery({
    queryKey: ['auth', 'factors'],
    queryFn: () => listFactors(api),
    retry: false,
  });

  const [displayName, setDisplayName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [language, setLanguage] = useState<AppLanguage>('en');
  const [timezone, setTimezone] = useState<DisplayTimezone>('UTC');

  useEffect(() => {
    if (profile.data) {
      setDisplayName(profile.data.displayName);
      setJobTitle(profile.data.jobTitle ?? '');
    }
  }, [profile.data]);

  useEffect(() => {
    if (prefs.data) {
      setLanguage(languageOfLocale(prefs.data.locale));
      setTimezone(prefs.data.timezone);
    }
  }, [prefs.data]);

  const save = useMutation({
    mutationFn: async (): Promise<[MyProfileView | null, DisplayPreferencesView | null]> => {
      const trimmedTitle = jobTitle.trim();
      return Promise.all([
        profile.data
          ? saveMyProfile(api, organizationSlug, {
              displayName: displayName.trim(),
              jobTitle: trimmedTitle === '' ? null : trimmedTitle,
            })
          : Promise.resolve(null),
        // Only when the language or time zone changed: a name-only save leaves the display record alone.
        prefs.data &&
        (language !== languageOfLocale(prefs.data.locale) || timezone !== prefs.data.timezone)
          ? saveLanguageAndTimezone(api, organizationSlug, prefs.data, { language, timezone })
          : Promise.resolve(null),
      ]);
    },
    onSuccess: ([savedProfile, savedPrefs]) => {
      if (savedProfile) queryClient.setQueryData(profileKey, savedProfile);
      if (savedPrefs) {
        queryClient.setQueryData(prefsKey, savedPrefs);
        // The one app-wide language: publishing it here re-renders every string and flips `dir`.
        activeLocale.set(savedPrefs.locale);
      }
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };

  const loading = profile.isPending || prefs.isPending;
  const canSave = Boolean(profile.data || prefs.data);
  const twoStepOn = Array.isArray(factors.data?.factors)
    ? factors.data.factors.some((factor) => factor.confirmedAt !== null)
    : false;

  return (
    <SettingsShell
      section="preferences"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      // FIX3 item 10: headed with its menu name (the menu says Preferences).
      title={translate('RouteTitle.preferences')}
    >
      <div className="tm-prefs">
        <form
          className="tm-prefs-card"
          style={S.card}
          onSubmit={onSubmit}
          aria-label={t('Profile.title')}
          noValidate
        >
          {loading ? (
            <LoadingRegion label={t('Profile.loading')}>
              <Skeleton height="56px" />
              <Skeleton height="48px" />
              <Skeleton height="48px" />
            </LoadingRegion>
          ) : null}

          {profile.isError ? (
            <InlineAlert tone="danger" title={t('Profile.profileLoadError')} live>
              {describeError(profile.error, t)}
            </InlineAlert>
          ) : null}

          {profile.data ? (
            <>
              <div style={S.photoRow}>
                <Avatar name={displayName || profile.data.displayName} size="feature" />
              </div>
              <Field
                label={t('Profile.fullName')}
                name="displayName"
                autoComplete="name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
              <Field
                label={t('Profile.signInEmail')}
                name="email"
                type="email"
                value={profile.data.email}
                readOnly
                hint={t('Profile.signInEmailHint')}
                style={S.readOnly}
              />
              <Field
                label={t('Profile.jobTitle')}
                name="jobTitle"
                autoComplete="organization-title"
                value={jobTitle}
                onChange={(event) => setJobTitle(event.target.value)}
              />
            </>
          ) : null}

          <hr className="tm-prefs-rule" />

          <section aria-labelledby="tm-profile-language" className="tm-prefs-group">
            <h2 id="tm-profile-language" className="tm-prefs-heading">
              {t('Profile.languageHeading')}
            </h2>
            {prefs.isError ? (
              <InlineAlert tone="danger" title={t('Profile.preferencesLoadError')} live>
                {describeError(prefs.error, t)}
              </InlineAlert>
            ) : null}
            {prefs.data ? (
              <>
                <p style={S.lead} id="tm-profile-language-lead">
                  {t('Profile.languageLead')}
                </p>
                {/* One of two, so radios; drawn as the frame's check boxes (Figma 371:1836). */}
                <fieldset
                  role="radiogroup"
                  style={S.fieldset}
                  aria-describedby="tm-profile-language-lead"
                >
                  <legend style={S.legend}>{t('Profile.languageHeading')}</legend>
                  {LANGUAGES.map((option) => (
                    <div key={option.id} className="tm-choice">
                      <span className="tm-choice__row">
                        <input
                          id={`tm-profile-language-${option.id}`}
                          type="radio"
                          name="language"
                          className="tm-checkbox"
                          value={option.id}
                          checked={language === option.id}
                          onChange={() => setLanguage(option.id)}
                        />
                        <label
                          className="tm-choice__label"
                          htmlFor={`tm-profile-language-${option.id}`}
                        >
                          <span lang={option.lang}>{option.label}</span>
                        </label>
                      </span>
                    </div>
                  ))}
                </fieldset>
                <TimeZoneSelect
                  label={t('Profile.timeZone')}
                  name="timezone"
                  value={timezone}
                  onChange={setTimezone}
                />
              </>
            ) : null}
          </section>

          <hr className="tm-prefs-rule" />

          <section aria-labelledby="tm-profile-security" className="tm-prefs-group">
            <h2 id="tm-profile-security" className="tm-prefs-heading">
              {t('Profile.securityHeading')}
            </h2>
            <div style={S.row}>
              <span style={S.rowText}>
                <span style={S.rowLabel}>{t('Profile.twoStep')}</span>
                <span style={S.rowHint}>{t('Profile.twoStepHint')}</span>
              </span>
              <span style={S.rowEnd}>
                <span style={S.pill} data-testid="two-step-state">
                  <span style={S.pillMark} aria-hidden="true" />
                  {twoStepOn ? t('Profile.on') : t('Profile.off')}
                </span>
                <Link
                  href={`/${organizationSlug}/settings/two-step`}
                  className={
                    twoStepOn ? 'tm-prefs-capsule' : 'tm-prefs-capsule tm-prefs-capsule--ink'
                  }
                  style={S.capsule}
                >
                  {twoStepOn ? t('Profile.manage') : t('Profile.turnOn')}
                </Link>
              </span>
            </div>
            <PasswordRow
              api={api}
              t={t}
              needsCode={factors.data?.reauthNeedsAuthenticatorCode ?? false}
            />
          </section>
          <hr className="tm-prefs-rule" />

          <PrivacyPrefs organizationSlug={organizationSlug} client={api} />

          {save.isError ? (
            <InlineAlert tone="danger" title={t('Profile.couldNotSave')} live>
              {describeError(save.error, t)}
            </InlineAlert>
          ) : null}
          {save.isSuccess ? (
            <InlineAlert tone="success" title={t('Profile.saved')} live>
              {null}
            </InlineAlert>
          ) : null}

          {canSave ? (
            <div style={S.footer}>
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={save.isPending}
                loadingLabel={t('Profile.saving')}
              >
                {t('Profile.save')}
              </Button>
            </div>
          ) : null}
        </form>
      </div>
    </SettingsShell>
  );
}

/**
 * "Password · Change password": an inline form that changes the person's own password. ACCOUNT
 * item 4: the current password (and the authenticator code when two-step is on) is asked first,
 * as the API requires; without it every change was refused. Left empty, a first password is set.
 */
function PasswordRow({
  api,
  t,
  needsCode,
}: {
  api: ApiClient;
  t: ProfileTranslate;
  /** STEPUPFIX: the server's rule — an authenticator app, not e-mail codes, needs the code. */
  needsCode: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [code, setCode] = useState('');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [mismatch, setMismatch] = useState(false);

  const change = useMutation({
    mutationFn: (newPassword: string) =>
      changeMyPassword(api, {
        currentPassword: current,
        newPassword,
        ...(needsCode ? { code: code.replace(/\D/gu, '') } : {}),
      }),
    onSuccess: () => {
      setOpen(false);
      setCurrent('');
      setCode('');
      setFirst('');
      setSecond('');
    },
  });

  const submit = () => {
    if (first !== second) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    change.mutate(first);
  };

  return (
    <>
      <div style={S.row}>
        <span style={S.rowText}>
          <span style={S.rowLabel}>{t('Profile.password')}</span>
          <span style={S.rowHint}>{t('Profile.passwordHint')}</span>
        </span>
        {open ? null : (
          <Button
            type="button"
            tone="outline"
            size="accessible"
            onClick={() => {
              change.reset();
              setOpen(true);
            }}
          >
            {t('Profile.changePassword')}
          </Button>
        )}
      </div>
      {open ? (
        <div style={S.passwordForm}>
          <Field
            label={t('Profile.currentPassword')}
            hint={t('Profile.currentPasswordHint')}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          {needsCode ? (
            <Field
              label={t('Profile.authenticatorCode')}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              dir="ltr"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          ) : null}
          <Field
            label={t('Profile.newPassword')}
            type="password"
            autoComplete="new-password"
            value={first}
            onChange={(event) => setFirst(event.target.value)}
          />
          <Field
            label={t('Profile.confirmPassword')}
            type="password"
            autoComplete="new-password"
            value={second}
            onChange={(event) => setSecond(event.target.value)}
            error={mismatch ? t('Profile.passwordMismatch') : undefined}
          />
          {change.isError ? (
            <InlineAlert tone="danger" title={t('Profile.couldNotSave')} live>
              {describeError(change.error, t)}
            </InlineAlert>
          ) : null}
          <div style={S.rowEnd}>
            <Button
              type="button"
              tone="text"
              onClick={() => {
                setOpen(false);
                setCurrent('');
                setCode('');
              }}
            >
              {t('Profile.cancel')}
            </Button>
            <Button
              type="button"
              tone="ink"
              loading={change.isPending}
              disabled={first === ''}
              onClick={submit}
            >
              {t('Profile.savePassword')}
            </Button>
          </div>
        </div>
      ) : null}
      {change.isSuccess ? (
        <InlineAlert tone="success" title={t('Profile.passwordSaved')} live>
          {null}
        </InlineAlert>
      ) : null}
    </>
  );
}

function describeError(error: unknown, t: ProfileTranslate): string {
  // ACCOUNT item 4: an existing password is changed only with the current one.
  if (
    error instanceof ApiRequestError &&
    error.status === 403 &&
    error.code === 'reauthentication_required'
  ) {
    return t('Profile.currentPasswordRequired');
  }
  // F01 (wave 9): a first password needs a sign-in from the last few minutes.
  if (
    error instanceof ApiRequestError &&
    error.status === 401 &&
    error.code === 'reauthentication_required'
  ) {
    return t('Profile.freshSignInRequired');
  }
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('Profile.networkError');
  return t('Profile.genericError');
}
