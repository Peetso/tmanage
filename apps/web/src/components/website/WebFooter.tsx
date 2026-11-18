'use client';

import { Fragment } from 'react';
import { usePathname } from 'next/navigation';
import Link from './WebLink';
import { activeLocale } from '../../lib/i18n/locale-store';
import {
  OFFERED_LOCALES,
  catalogNameOf,
  isBetaLocale,
  localeLangAttribute,
  localeNativeName,
} from '../../lib/i18n/catalog-status';
import type { DisplayLocale } from '../../lib/api/display-preferences';
import { languageSwitchTarget, localizeHref } from '../../lib/i18n/public-locale-routes';
import { useRouteLocale } from '../../lib/i18n/route-locale';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useT } from '../../lib/i18n/use-t';
import { WebIcon } from './WebIcon';
import { BrandLockup } from './primitives';
import './language-switch.css';
import {
  DESKTOP_APP_HREF,
  FOOTER_COLUMNS,
  FOOTER_LEGAL,
  FOOTER_MOBILE_GROUPS,
  FOOTER_SOCIAL,
} from './site-nav';
import type { MessageKey } from '../../lib/i18n/t';
import { HELLO_EMAIL } from '../../lib/public-contact';

/** The catalog-language rule `translate()` uses: the primary subtag decides. */
export function isArabicLocale(locale: string): boolean {
  return locale.split('-')[0]?.toLowerCase() === 'ar';
}

/** The switch's languages: the two reviewed ones, then every beta catalog in offered order. */
const SWITCH_LOCALES = [
  'en-US',
  'ar-EG',
  ...OFFERED_LOCALES.filter(isBetaLocale),
] as const satisfies readonly DisplayLocale[];

type SwitchLocale = (typeof SWITCH_LOCALES)[number];

/** "English" for the one English entry (it stands for every English locale); else the own name. */
function switchName(value: SwitchLocale): string {
  return value === 'en-US' ? 'English' : localeNativeName(value);
}

/**
 * Web/Language switch — "English · العربية". Sets the app's active locale, which
 * `LocaleDirectionProvider` turns into `lang`/`dir` on `<html>`, so Arabic mirrors the page.
 * The pressed state reads the very locale `useT()` translates with, by the same language rule
 * as `translate()`, so the switch can never mark Arabic while the chrome renders English.
 *
 * On a public page with an Arabic twin it then loads the other language's URL (`/pricing` ↔
 * `/ar/pricing`, `public-locale-routes.ts`): a full load, so the prerendered page arrives in its
 * own language and direction. The locale is set (and saved) first, so the next page boots in it.
 */
export function LanguageSwitch() {
  const t = useT();
  const locale = useActiveLocale();
  const pathname = usePathname();
  const catalog = catalogNameOf(locale);
  // R12 R2: the beta languages switch in place — they have no public `/xx` routes of their own,
  // so on an Arabic page they load the English twin (the page's words then follow the tab).
  const choose = (next: DisplayLocale) => {
    activeLocale.set(next);
    const target = languageSwitchTarget(
      pathname,
      next === 'ar-EG',
      window.location.search,
      window.location.hash,
    );
    if (target !== undefined) window.location.assign(target);
  };
  const current = SWITCH_LOCALES.find((value) => catalogNameOf(value) === catalog) ?? 'en-US';
  // VR2 fixes 5 and 7: one list, drawn twice. From tablet width up it is the dotted row; below
  // 768 px `language-switch.css` shows the native menu instead, so eight names never wrap with a
  // dot left hanging at a line end. CSS hides the other form, so only one is ever announced.
  return (
    <div className="tm-web-lang">
      <div className="tm-web-lang__row" role="group" aria-label={t('WebFooter.language')}>
        {SWITCH_LOCALES.map((value, index) => (
          <Fragment key={value}>
            {index > 0 ? <span aria-hidden="true">·</span> : null}
            <button
              type="button"
              className="tm-web-lang__option"
              lang={localeLangAttribute(value)}
              dir={isArabicLocale(value) ? 'rtl' : undefined}
              aria-pressed={value === current}
              onClick={() => choose(value)}
            >
              {switchName(value)}
            </button>
          </Fragment>
        ))}
      </div>
      <select
        className="tm-field__control tm-web-lang__menu"
        aria-label={t('WebFooter.language')}
        value={current}
        onChange={(event) => {
          const next = SWITCH_LOCALES.find((value) => value === event.target.value);
          if (next !== undefined) choose(next);
        }}
      >
        {SWITCH_LOCALES.map((value) => (
          <option key={value} value={value} lang={localeLangAttribute(value)}>
            {switchName(value)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Web/Footer — seven link columns with mono headings on the sunken band, the language switch,
 * and the legal row with three social Web/Icon orbs. Below 768 px it is Web/Footer · Mobile:
 * the same links as Icon/Plus accordions.
 */
export function WebFooter() {
  const t = useT();
  const year = 2026;
  // The social orbs are plain anchors (two leave the site), so an Arabic page localizes the
  // in-site one ("راسل TManage" → /ar/contact) itself, as WebLink does for every other link.
  const arabicRoute = useRouteLocale() !== undefined;
  return (
    <footer className="tm-web-footer">
      <div className="tm-web-footer__inner">
        <div className="tm-web-footer__top">
          <div className="tm-web-footer__brand">
            <BrandLockup />
            <p className="tm-web-footer__tagline">{t('WebFooter.tagline')}</p>
          </div>
          <div className="tm-web-footer__lang tm-web-footer__lang--desktop">
            <LanguageSwitch />
          </div>
        </div>

        <nav className="tm-web-footer__columns" aria-label={t('WebFooter.footerNav')}>
          {FOOTER_COLUMNS.map((column) => (
            <div key={column.heading} className="tm-web-footer__column">
              <p className="tm-web-footer__heading">{t(column.heading)}</p>
              <ul className="tm-web-footer__links">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link href={link.href}>{t(link.label)}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <nav className="tm-web-footer__accordions" aria-label={t('WebFooter.footerNav')}>
          {FOOTER_MOBILE_GROUPS.map((group) => (
            <details key={group.heading} className="tm-web-accordion">
              <summary className="tm-web-accordion__summary">
                {t(group.heading)}
                <WebIcon name="plus" className="tm-web-accordion__plus" />
                <WebIcon name="minus" className="tm-web-accordion__minus" />
              </summary>
              <ul className="tm-web-footer__links tm-web-accordion__panel">
                {group.links.map((link) => (
                  <li key={link.label}>
                    <Link href={link.href}>{t(link.label)}</Link>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </nav>

        <div className="tm-web-footer__bottom">
          <div className="tm-web-footer__lang tm-web-footer__lang--mobile">
            <LanguageSwitch />
          </div>
          <p className="tm-web-footer__legal">
            <span>© {year} TManage</span>
            <Link href={DESKTOP_APP_HREF} className="tm-web-footer__desktop">
              {t('SiteNav.desktopAppWindows' as MessageKey)}
            </Link>
            {FOOTER_LEGAL.map((link) => (
              <Link key={link.label} href={link.href}>
                {t(link.label)}
              </Link>
            ))}
            <a href={`mailto:${HELLO_EMAIL}`} dir="ltr">
              {HELLO_EMAIL}
            </a>
          </p>
          <ul className="tm-web-footer__social">
            {FOOTER_SOCIAL.map((item) => (
              <li key={item.label}>
                <a
                  href={arabicRoute ? localizeHref(item.href) : item.href}
                  className="tm-web-orb tm-web-orb--outline tm-web-orb--default"
                  aria-label={t(item.label)}
                  {...(item.href.startsWith('http') ? { rel: 'noopener noreferrer' } : {})}
                >
                  <WebIcon name={item.icon} />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
