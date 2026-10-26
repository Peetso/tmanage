'use client';

import Link from './WebLink';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { WebIcon } from './WebIcon';
import { BrandLockup, ButtonLink, MenuItem, cx } from './primitives';
import { NAV_ACTIONS, NAV_ENTRIES, type WebMegaMenu } from './site-nav';
import { MegaMenuFeatured } from './MegaMenu';
import { useT } from '../../lib/i18n/use-t';

export interface WebNavProps {
  /** `paper` (default) on the paper canvas; `ink` over a dark hero (Website components §01). */
  theme?: 'paper' | 'ink';
  /** The id of the current top-level entry (`product`, `solutions`, `client-portal`, `pricing`, `resources`). */
  current?: string | undefined;
  /** Stick to the top of the viewport while the page scrolls. Default true. */
  sticky?: boolean;
}

/**
 * Web/Nav — the site's top bar on the 1248 column: brand, Product ▾ · Solutions ▾ · Client portal
 * · Pricing · Resources ▾, then Sign in, Book a demo, Start free. The three ▾ triggers open
 * Web/Mega menu panels 8 px under the bar. Below 1024 px it becomes Web/Nav · Mobile: brand,
 * Start free and the menu orb, which opens the full-screen drawer with the groups as accordions.
 */
export function WebNav({ theme = 'paper', current, sticky = true }: WebNavProps) {
  const t = useT();
  const [open, setOpen] = useState<WebMegaMenu['id'] | null>(null);
  const [drawer, setDrawer] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A mouse click on a trigger arrives just after the hover that already opened it; without
  // this the click would close the menu the pointer had only just opened.
  const hoverOpenedAt = useRef(0);
  const baseId = useId();

  const close = useCallback((returnFocus = false) => {
    setOpen((was) => {
      if (returnFocus && was) triggerRefs.current.get(was)?.focus();
      return null;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, close]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawer(false);
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [drawer]);

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(null), 160);
  };

  const openMenu = NAV_ENTRIES.find(
    (entry): entry is { kind: 'menu'; menu: WebMegaMenu } =>
      entry.kind === 'menu' && entry.menu.id === open,
  )?.menu;

  return (
    <header
      ref={rootRef}
      className={cx('tm-web-nav', `tm-web-nav--${theme}`, sticky && 'tm-web-nav--sticky')}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') scheduleClose();
      }}
      onPointerEnter={cancelClose}
    >
      <div className="tm-web-nav__bar">
        <BrandLockup tone={theme} />

        <nav className="tm-web-nav__menu" aria-label={t('WebNav.primaryNav')}>
          <ul className="tm-web-nav__list">
            {NAV_ENTRIES.map((entry) =>
              entry.kind === 'menu' ? (
                <li key={entry.menu.id}>
                  <button
                    type="button"
                    ref={(node) => {
                      if (node) triggerRefs.current.set(entry.menu.id, node);
                    }}
                    className="tm-web-nav__trigger"
                    aria-expanded={open === entry.menu.id}
                    aria-controls={`${baseId}-${entry.menu.id}`}
                    data-current={current === entry.menu.id ? '' : undefined}
                    onClick={() => {
                      const justHovered = Date.now() - hoverOpenedAt.current < 500;
                      setOpen((was) =>
                        was === entry.menu.id && !justHovered ? null : entry.menu.id,
                      );
                    }}
                    onPointerEnter={(event) => {
                      if (event.pointerType === 'mouse') {
                        cancelClose();
                        if (open !== entry.menu.id) hoverOpenedAt.current = Date.now();
                        setOpen(entry.menu.id);
                      }
                    }}
                  >
                    {t(entry.menu.label)}
                    <WebIcon name="chevron-down" size={14} className="tm-web-nav__chevron" />
                  </button>
                </li>
              ) : (
                <li key={entry.id}>
                  <Link
                    href={entry.href}
                    className={cx('tm-web-nav__link', entry.accent && 'tm-web-nav__link--accent')}
                    aria-current={current === entry.id ? 'page' : undefined}
                    onPointerEnter={() => setOpen(null)}
                  >
                    {t(entry.label)}
                  </Link>
                </li>
              ),
            )}
          </ul>
        </nav>

        <div className="tm-web-nav__actions">
          <Link href={NAV_ACTIONS.signIn.href} className="tm-web-nav__signin">
            {t(NAV_ACTIONS.signIn.label)}
          </Link>
          <ButtonLink
            href={NAV_ACTIONS.demo.href}
            tone={theme === 'ink' ? 'outline-ink' : 'outline'}
            className="tm-web-nav__demo"
          >
            {t(NAV_ACTIONS.demo.label)}
          </ButtonLink>
          <ButtonLink href={NAV_ACTIONS.start.href} tone="lime" className="tm-web-nav__start">
            {t(NAV_ACTIONS.start.label)}
          </ButtonLink>
          <button
            type="button"
            className="tm-web-nav__menu-orb"
            aria-label={t('WebNav.openMenu')}
            aria-expanded={drawer}
            aria-controls={`${baseId}-drawer`}
            onClick={() => setDrawer(true)}
          >
            <WebIcon name="menu" />
          </button>
        </div>
      </div>

      {NAV_ENTRIES.map((entry) =>
        entry.kind === 'menu' ? (
          <div
            key={entry.menu.id}
            id={`${baseId}-${entry.menu.id}`}
            className="tm-web-mega"
            hidden={openMenu?.id !== entry.menu.id}
          >
            <MegaMenuPanel menu={entry.menu} onNavigate={() => close()} />
          </div>
        ) : null,
      )}

      <div
        id={`${baseId}-drawer`}
        className="tm-web-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('WebNav.siteMenu')}
        hidden={!drawer}
      >
        <div className="tm-web-drawer__bar">
          <BrandLockup />
          <button
            type="button"
            className="tm-web-nav__menu-orb tm-web-nav__menu-orb--close"
            aria-label={t('WebNav.closeMenu')}
            onClick={() => setDrawer(false)}
          >
            <WebIcon name="close" />
          </button>
        </div>
        <div className="tm-web-drawer__body">
          {NAV_ENTRIES.map((entry) =>
            entry.kind === 'menu' ? (
              <details key={entry.menu.id} className="tm-web-accordion">
                <summary className="tm-web-accordion__summary">
                  {t(entry.menu.label)}
                  <WebIcon name="plus" className="tm-web-accordion__plus" />
                  <WebIcon name="minus" className="tm-web-accordion__minus" />
                </summary>
                <div className="tm-web-accordion__panel">
                  {entry.menu.groups.map((group) => (
                    <div key={group.heading} className="tm-web-drawer__group">
                      <p className="tm-web-mega__heading">{t(group.heading)}</p>
                      {group.links.map((link) => (
                        <MenuItem
                          key={link.label}
                          {...link}
                          label={t(link.label)}
                          hint={t(link.hint)}
                          onNavigate={() => setDrawer(false)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </details>
            ) : (
              <Link
                key={entry.id}
                href={entry.href}
                className="tm-web-accordion__summary tm-web-drawer__link"
                onClick={() => setDrawer(false)}
              >
                {t(entry.label)}
              </Link>
            ),
          )}
        </div>
        <div className="tm-web-drawer__actions">
          <ButtonLink href={NAV_ACTIONS.start.href} tone="lime" onClick={() => setDrawer(false)}>
            {t(NAV_ACTIONS.start.label)}
          </ButtonLink>
          <ButtonLink href={NAV_ACTIONS.demo.href} tone="outline" onClick={() => setDrawer(false)}>
            {t(NAV_ACTIONS.demo.label)}
          </ButtonLink>
          <Link
            href={NAV_ACTIONS.signIn.href}
            className="tm-web-nav__signin"
            onClick={() => setDrawer(false)}
          >
            {t(NAV_ACTIONS.signIn.label)}
          </Link>
        </div>
      </div>
    </header>
  );
}

/** Web/Mega menu — labelled groups of Web/Menu items and the ink featured card. */
export function MegaMenuPanel({
  menu,
  onNavigate,
}: {
  menu: WebMegaMenu;
  onNavigate?: (() => void) | undefined;
}) {
  const t = useT();
  return (
    <div className={cx('tm-web-mega__panel', `tm-web-mega__panel--${menu.groups.length}`)}>
      {menu.groups.map((group) => (
        <div key={group.heading} className="tm-web-mega__group">
          <p className="tm-web-mega__heading">{t(group.heading)}</p>
          <ul className="tm-web-mega__links">
            {group.links.map((link) => (
              <li key={link.label}>
                <MenuItem
                  {...link}
                  label={t(link.label)}
                  hint={t(link.hint)}
                  onNavigate={onNavigate}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
      <MegaMenuFeatured featured={menu.featured} onNavigate={onNavigate} />
    </div>
  );
}
