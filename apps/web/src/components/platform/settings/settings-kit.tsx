'use client';

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import type { MessageKey } from '../../../lib/i18n/t';
import { useT } from '../../../lib/i18n/use-t';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { withNumerals } from '../../../lib/i18n/display-format';

/**
 * Pieces the four Platform settings pages share (PA-10, SPEC §4 D1–D4): the Settings sub-nav,
 * `{name}` filling for catalog strings, the chip group the frames draw for severities, audiences
 * and rollouts, and the "Last changed by" line.
 */

export type SettingsPage =
  'general' | 'flags' | 'announcements' | 'maintenance' | 'keys' | 'incidents' | 'outreach';

const PAGES: readonly {
  id: Exclude<SettingsPage, 'keys' | 'incidents' | 'outreach'>;
  href: string;
  label: MessageKey;
}[] = [
  { id: 'general', href: '/platform/settings', label: 'PlatformSettings.navGeneral' },
  { id: 'flags', href: '/platform/settings/flags', label: 'PlatformSettings.navFlags' },
  {
    id: 'announcements',
    href: '/platform/settings/announcements',
    label: 'PlatformSettings.navAnnouncements',
  },
  {
    id: 'maintenance',
    href: '/platform/settings/maintenance',
    label: 'PlatformSettings.navMaintenance',
  },
];

const NAV: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 'var(--s2)' };

/**
 * The SETTINGS sub-nav (General, Feature flags, Announcements, Maintenance). The frames draw it in
 * the sidebar under Settings; `PlatformShell` (PA-02) only has Team sub-pages, so it renders here,
 * at the top of the page, until the shell grows the settings group.
 */
export function SettingsSubNav({ active }: { active: SettingsPage }) {
  const t = useT();
  const tOr = useTOr();
  // 56-02: Keys joins the group; its label comes with the i18n fragment (`PlatformKeys.nav`).
  const pages = [
    ...PAGES.map((page) => ({ ...page, text: t(page.label) })),
    { id: 'keys' as const, href: '/platform/settings/keys', text: tOr('PlatformKeys.nav', 'Keys') },
    // LANE-Q: the outreach campaign (import, start / pause / stop) needs platform.settings.edit.
    {
      id: 'outreach' as const,
      href: '/platform/settings/outreach',
      text: tOr('PlatformOutreach.nav', 'Outreach'),
    },
    // A17: the incident register sits with the platform settings.
    {
      id: 'incidents' as const,
      href: '/platform/incidents',
      text: tOr('Incidents.title', 'Incidents'),
    },
  ];
  return (
    <nav aria-label={t('PlatformSettings.navLabel')} style={NAV}>
      {pages.map((page) => (
        <Link
          key={page.id}
          href={page.href}
          className={`tm-cc-pill${page.id === active ? ' tm-cc-pill--on' : ''}`}
          {...(page.id === active ? { 'aria-current': 'page' as const } : {})}
        >
          {page.text}
        </Link>
      ))}
    </nav>
  );
}

/** Fill `{name}` placeholders in a catalog string. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}

/** A short date and time in the reader's locale, or `—`. */
export function formatWhen(iso: string | null, locale: string): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return new Intl.DateTimeFormat(withNumerals(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at);
}

/** One choice in a chip group. */
export interface ChipOption<Value extends string> {
  readonly value: Value;
  readonly label: ReactNode;
}

/** A single-choice chip group (radio semantics), as the frames draw severity / audience / rollout. */
export function ChipGroup<Value extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: Value;
  options: readonly ChipOption<Value>[];
  onChange: (value: Value) => void;
  disabled?: boolean;
}) {
  return (
    <div className="tm-stack tm-stack--tight">
      <span className="tm-cc-eyebrow">{label}</span>
      <div role="radiogroup" aria-label={label} style={NAV}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            disabled={disabled}
            className={`tm-cc-pill${option.value === value ? ' tm-cc-pill--on' : ''}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Last changed by Peter · 21 Oct 2026, 18:42", or nothing when never changed here. */
export function changedLine(
  change: { readonly at: string | null; readonly by: string | null },
  locale: string,
  t: ReturnType<typeof useT>,
): string | null {
  if (change.at === null) return null;
  return `${t('PlatformSettings.lastChangedBy')} ${change.by ?? '—'} · ${formatWhen(change.at, locale)}`;
}

/** `datetime-local` value (local time) for an ISO instant, or ''. */
export function toLocalInput(iso: string | null): string {
  if (iso === null) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const offset = at.getTimezoneOffset() * 60_000;
  return new Date(at.getTime() - offset).toISOString().slice(0, 16);
}

/** ISO instant for a `datetime-local` value, or `null` when empty or invalid. */
export function fromLocalInput(value: string): string | null {
  if (value.trim() === '') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}
