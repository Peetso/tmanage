'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { signOut } from '../../lib/api/session';
import { authBoundary } from '../../lib/auth-boundary';
import {
  DESKTOP_INSTALLER_HREF,
  DESKTOP_INSTALLER_SIZE_MB,
  offerDesktopDownload,
} from '../../lib/desktop-download';
import { activeLocale } from '../../lib/i18n/locale-store';
import {
  OFFERED_LOCALES,
  isBetaLocale,
  localeLangAttribute,
  localeNativeName,
} from '../../lib/i18n/catalog-status';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import './account-menu.css';

/** The `AccountMenu.*` keys ship as a wave fragment; the cast holds until they reach `en.json`. */
const key = (name: string) => `AccountMenu.${name}` as MessageKey;

export interface AccountMenuProps {
  organizationSlug: string;
  /** The signed-in person's initials; derived from `name` when omitted. */
  initials?: string;
  name?: string;
  email?: string;
  /** `rail` opens beside the rail orb; `header` drops below the portal header's end. */
  placement?: 'rail' | 'header';
}

function initialsOf(name: string | undefined): string {
  if (!name) return '';
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  // Arabic names take one letter (the design's "ع"); Latin names take first and last initials.
  const count = /\p{Script=Arabic}/u.test(name) ? 1 : 2;
  return parts
    .slice(0, count)
    .map((part) => Array.from(part)[0] ?? '')
    .join('')
    .toUpperCase();
}

/**
 * The account menu (Figma t2-a, 371:1809 / 371:2237): the account orb opens a card with the
 * person's initials, name and email, then Profile, Preferences, the language switch, AI assistant
 * and Access tokens, and Sign out below a rule. It is a disclosure button over a `role="menu"`
 * list — arrow keys, Home/End, Escape and an outside click behave as a menu should — and every
 * position is a logical property, so the card mirrors in Arabic without a second stylesheet.
 */
export function AccountMenu({
  organizationSlug,
  initials,
  name,
  email,
  placement = 'rail',
}: AccountMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const shown = initials ?? initialsOf(name);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  return (
    <div className="tm-account" data-placement={placement} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="tm-rail__account"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t(key('trigger'))}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{shown}</span>
      </button>
      {open ? (
        <AccountMenuPanel
          id={menuId}
          organizationSlug={organizationSlug}
          initials={shown}
          name={name}
          email={email}
          onClose={close}
        />
      ) : null}
    </div>
  );
}

/**
 * The open card. A separate component so `useRouter` runs only once the menu is open — the shells
 * render bare in tests and stories, where no Next router is mounted.
 */
function AccountMenuPanel({
  id,
  organizationSlug,
  initials,
  name,
  email,
  onClose,
}: {
  id: string;
  organizationSlug: string;
  initials: string;
  name: string | undefined;
  email: string | undefined;
  onClose: (returnFocus: boolean) => void;
}) {
  const t = useT();
  const router = useRouter();
  const locale = useActiveLocale();
  const menuRef = useRef<HTMLDivElement>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);
  const base = `/${encodeURIComponent(organizationSlug)}`;

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);

  useEffect(() => {
    items()[0]?.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      list[(next + list.length) % list.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(list.length - 1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      onClose(true);
    } else if (event.key === 'Tab') onClose(false);
  };

  // R12 R2 (Figma "Languages (R2)" 501:29283): "Language" opens the offered list in place; the
  // current language carries the check, and a pick is a choice the first-visit guess never undoes.
  const [languagesOpen, setLanguagesOpen] = useState(false);
  const chooseLanguage = (next: (typeof OFFERED_LOCALES)[number]) => {
    activeLocale.set(next);
    onClose(true);
  };

  const endSession = async () => {
    setSigningOut(true);
    setFailed(false);
    try {
      await signOut(browserApiClient());
      authBoundary.announce('signed-out');
      router.push('/sign-in');
    } catch {
      setFailed(true);
      setSigningOut(false);
    }
  };

  const linkItem = (href: string, label: MessageKey) => (
    <Link
      href={href}
      role="menuitem"
      tabIndex={-1}
      className="tm-account__item"
      onClick={() => onClose(false)}
    >
      {t(label)}
    </Link>
  );

  return (
    <div
      ref={menuRef}
      id={id}
      role="menu"
      tabIndex={-1}
      aria-label={t(key('menuLabel'))}
      className="tm-account__menu"
      onKeyDown={onKeyDown}
    >
      <div className="tm-account__head">
        <span className="tm-account__avatar" aria-hidden="true">
          {initials}
        </span>
        <div className="tm-account__who">
          {name ? <p className="tm-account__name">{name}</p> : null}
          {email ? (
            <p className="tm-account__email" dir="ltr">
              {email}
            </p>
          ) : null}
        </div>
      </div>
      <hr className="tm-account__rule" />
      {linkItem(`${base}/preferences`, key('profile'))}
      {linkItem(`${base}/settings/display`, key('preferences'))}
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="tm-account__item"
        aria-haspopup="true"
        aria-expanded={languagesOpen}
        onClick={() => setLanguagesOpen((value) => !value)}
      >
        {t(key('language'))}
        <span aria-hidden="true">{languagesOpen ? ' ▾' : ' ›'}</span>
      </button>
      {languagesOpen ? (
        <div role="group" aria-label={t('LanguagePicker.menuLabel')}>
          {OFFERED_LOCALES.map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={value === locale}
              tabIndex={-1}
              lang={localeLangAttribute(value)}
              className="tm-account__item tm-account__item--language"
              onClick={() => chooseLanguage(value)}
            >
              <span aria-hidden="true" className="tm-account__check">
                {value === locale ? '✓' : ''}
              </span>
              {localeNativeName(value)}
              {isBetaLocale(value) ? (
                <Badge className="tm-account__beta">{t('LanguagePicker.beta')}</Badge>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      {linkItem(`${base}/settings/ai-assistant`, key('aiAssistant'))}
      {linkItem(`${base}/settings/security`, key('accessTokens'))}
      {offerDesktopDownload(window) ? (
        <>
          <hr className="tm-account__rule" />
          {/* Figma 412:6812 / 412:6849. A plain anchor: the server, not Next.js, answers it. */}
          <a
            href={DESKTOP_INSTALLER_HREF}
            download
            role="menuitem"
            tabIndex={-1}
            className="tm-account__item"
            onClick={() => onClose(false)}
          >
            {t(key('downloadDesktop'))}
          </a>
          <p className="tm-account__hint">
            {t(key('downloadDesktopHint')).replace('{size}', String(DESKTOP_INSTALLER_SIZE_MB))}
          </p>
        </>
      ) : null}
      <hr className="tm-account__rule" />
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="tm-account__item"
        aria-disabled={signingOut || undefined}
        onClick={() => {
          if (!signingOut) void endSession();
        }}
      >
        {t(key(signingOut ? 'signingOut' : 'signOut'))}
      </button>
      {failed ? (
        <p className="tm-account__error" role="alert">
          {t(key('signOutFailed'))}
        </p>
      ) : null}
    </div>
  );
}
