'use client';

import {
  useEffect,
  useId,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { NotificationOptIn } from '../pwa/NotificationOptIn';
import { browserApiClient } from '../../lib/api/browser-client';
import { getPreferences, updatePreferences } from '../../lib/api/preferences';
import type {
  DensityPreference,
  PreferenceLocale,
  ThemePreference,
  UserPreferencesView,
} from '../../lib/api/preferences';
import { listOrganizations } from '../../lib/api/organizations';
import { listFactors } from '../../lib/api/auth';
import { getQuietHours } from '../../lib/api/quiet-hours';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/preferences.css';

export interface PreferencesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const THEMES: readonly { id: ThemePreference; label: string }[] = [
  { id: 'system', label: 'Match my device' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

const DENSITIES: readonly { id: DensityPreference; label: string }[] = [
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'compact', label: 'Compact' },
];

const LOCALES: readonly { id: PreferenceLocale; label: string }[] = [
  { id: 'en', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
];

/** How each membership role reads on screen, with what it means for the person holding it. */
const ROLE_COPY: Readonly<Record<string, string>> = {
  owner: 'Owner. Only another owner can change this.',
  org_admin: 'Admin. An owner can change this from People.',
  admin: 'Admin. An owner can change this from People.',
  manager: 'Manager. An owner or admin can change this from People.',
  member: 'Member. An owner or admin can change this from People.',
  guest: 'Freelancer or partner. An owner or admin can change this from People.',
};

// ── Shared pieces for the preference screens (PREF-01…05) ─────────────────────────────────────

/** The sections under the account orb, in PREF-01's "YOURS ONLY" order. */
export type PreferencesSection =
  'profile' | 'appearance' | 'notifications' | 'accessibility' | 'keyboard' | 'ai-assistant';

const SECTIONS: readonly { id: PreferencesSection; label: string; href: string }[] = [
  { id: 'profile', label: 'Profile', href: '/preferences' },
  { id: 'appearance', label: 'Appearance', href: '/settings/display' },
  { id: 'notifications', label: 'Notifications', href: '/inbox/notification-preferences' },
  { id: 'accessibility', label: 'Accessibility', href: '/settings/accessibility' },
  { id: 'keyboard', label: 'Keyboard', href: '/preferences?section=keyboard' },
  // Every member's own keys, so it sits under the account orb, not under Control.
  { id: 'ai-assistant', label: 'AI assistant', href: '/settings/ai-assistant' },
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
  return (
    <div>
      <h2 id={headingId} className="tm-prefs-nav__heading">
        Yours only
      </h2>
      <ul className="tm-prefs-nav" aria-labelledby={headingId}>
        {SECTIONS.map((section) => (
          <li key={section.id}>
            <Link
              href={`/${organizationSlug}${section.href}`}
              className="tm-prefs-nav__link"
              {...(section.id === current ? { 'aria-current': 'page' as const } : {})}
            >
              {section.label}
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

/**
 * **Profile and account (PREF-01, x182, module 20) — the page under the account orb.**
 *
 * PREF-01's frame: the "YOURS ONLY" column, a 38px title, the settings card on the left and the
 * role / desktop-notice cards on the right. Every value on it is read from the API: the language,
 * theme and density from `GET .../me/preferences` (written back in full by `PUT`), the role from the
 * organizations list, two-factor from `/v1/auth/factors`, quiet hours from `.../me/quiet-hours`.
 * The design's name, photo, email and working-hours fields have no endpoint yet, so they are not
 * drawn rather than filled with placeholder values.
 *
 * Authorization is the API's: a refusal is turned into a sentence by `describeError()`, never a
 * blank page; and the form sends every setting on save and shows the persisted response.
 */
export function PreferencesScreen({
  organizationSlug,
  organizationName,
  client,
}: PreferencesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['preferences', organizationSlug];

  const preferences = useQuery({
    queryKey,
    queryFn: () => getPreferences(api, organizationSlug),
  });

  const organizations = useQuery({
    queryKey: ['shell', 'organizations'],
    queryFn: () => listOrganizations(api),
    staleTime: 5 * 60_000,
  });

  const factors = useQuery({
    queryKey: ['auth', 'factors'],
    queryFn: () => listFactors(api),
    retry: false,
  });

  const quietHours = useQuery({
    queryKey: ['quiet-hours', organizationSlug],
    queryFn: () => getQuietHours(api, organizationSlug),
    retry: false,
  });

  const [theme, setTheme] = useState<ThemePreference>('system');
  const [locale, setLocale] = useState<PreferenceLocale>('en');
  const [density, setDensity] = useState<DensityPreference>('comfortable');

  // Seed the form from the server's row once it arrives. The read is the source of truth.
  useEffect(() => {
    if (preferences.data) {
      setTheme(preferences.data.theme);
      setLocale(preferences.data.locale);
      setDensity(preferences.data.density);
    }
  }, [preferences.data]);

  const save = useMutation({
    mutationFn: (input: UserPreferencesView) => updatePreferences(api, organizationSlug, input),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate({ theme, locale, density });
  };

  const formReady = !preferences.isPending && !preferences.isError;
  const orgList = Array.isArray(organizations.data) ? organizations.data : [];
  const role = orgList.find((org) => org.slug === organizationSlug)?.role;
  const roleCopy = role ? (ROLE_COPY[role] ?? role.replace(/_/g, ' ')) : undefined;
  const confirmedFactors = Array.isArray(factors.data?.factors)
    ? factors.data.factors.filter((factor) => factor.confirmedAt !== null)
    : undefined;
  const quiet =
    quietHours.data && typeof quietHours.data.enabled === 'boolean' ? quietHours.data : undefined;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow="Preferences · Profile"
      title="How the app reads for you"
      actions={
        formReady ? (
          <button
            type="submit"
            form="tm-preferences-form"
            className="tm-prefs-capsule tm-prefs-capsule--ink"
            aria-label="Save preferences"
            disabled={save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        ) : null
      }
      contextRail={<PreferencesNav organizationSlug={organizationSlug} current="profile" />}
    >
      <div className="tm-prefs">
        <div className="tm-prefs__main">
          <section className="tm-prefs-card" aria-labelledby="tm-preferences-heading">
            <h2 id="tm-preferences-heading" className="tm-prefs-eyebrow">
              Language and appearance
            </h2>

            {preferences.isError ? (
              <InlineAlert tone="danger" title="Could not load your preferences" live>
                {describeError(preferences.error)}
              </InlineAlert>
            ) : null}

            {preferences.isPending ? (
              <LoadingRegion label="Loading your preferences.">
                <Skeleton height="46px" />
                <Skeleton height="46px" />
                <Skeleton height="46px" />
              </LoadingRegion>
            ) : null}

            {formReady ? (
              <form
                id="tm-preferences-form"
                className="tm-prefs-fields"
                onSubmit={onSubmit}
                aria-label="Appearance and language"
              >
                <PreferenceSelect
                  label="Language"
                  name="locale"
                  value={locale}
                  onChange={(event) => setLocale(event.target.value as PreferenceLocale)}
                >
                  {LOCALES.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </PreferenceSelect>

                <PreferenceSelect
                  label="Theme"
                  name="theme"
                  value={theme}
                  onChange={(event) => setTheme(event.target.value as ThemePreference)}
                >
                  {THEMES.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </PreferenceSelect>

                <PreferenceSelect
                  label="Density"
                  name="density"
                  value={density}
                  onChange={(event) => setDensity(event.target.value as DensityPreference)}
                >
                  {DENSITIES.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </PreferenceSelect>

                <div className="tm-prefs-field">
                  <span className="tm-prefs-field__label">Quiet hours</span>
                  <span className="tm-prefs-field__readout">
                    <span>
                      {quiet
                        ? quiet.enabled
                          ? `${quiet.startTime} – ${quiet.endTime} ${quiet.timezone}`
                          : 'Off'
                        : '—'}
                    </span>
                    <Link href={`/${organizationSlug}/settings/quiet-hours`}>Change</Link>
                  </span>
                </div>

                {save.isError ? (
                  <div className="tm-prefs-field--wide">
                    <InlineAlert tone="danger" title="Could not save your preferences" live>
                      {describeError(save.error)}
                    </InlineAlert>
                  </div>
                ) : null}

                {save.isSuccess ? (
                  <div className="tm-prefs-field--wide">
                    <InlineAlert tone="success" title="Preferences saved" live>
                      Your appearance and language settings are up to date.
                    </InlineAlert>
                  </div>
                ) : null}
              </form>
            ) : null}
          </section>
        </div>

        <div className="tm-prefs__side">
          <section className="tm-prefs-card tm-prefs-card--tight" aria-labelledby="tm-role-heading">
            <h2 id="tm-role-heading" className="tm-prefs-card__title">
              Your role
            </h2>
            <p className="tm-prefs-card__body">{roleCopy ?? organizationName}</p>
            <hr className="tm-prefs-rule" />
            <h3 className="tm-prefs-eyebrow">Sign-in</h3>
            <p className="tm-prefs-card__body">
              {confirmedFactors === undefined
                ? 'Two-factor status unavailable'
                : confirmedFactors.length > 0
                  ? 'Two-factor on'
                  : 'Two-factor off'}
              {' · '}
              <Link href={`/${organizationSlug}/settings/security`}>Access tokens</Link>
            </p>
          </section>

          {/* Module 22's desktop companion: a per-browser permission the server never holds, so
              it stands apart from the server-backed form. */}
          <div className="tm-prefs-card tm-prefs-card--paper tm-prefs-card--grow">
            <NotificationOptIn />
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped before your preferences loaded.';
  return 'Something went wrong with your preferences.';
}
