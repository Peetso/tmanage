'use client';

import Link from 'next/link';
import { activeLocale } from '../../lib/i18n/locale-store';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useT } from '../../lib/i18n/use-t';
import { WebIcon } from './WebIcon';
import { BrandLockup } from './primitives';
import { FOOTER_COLUMNS, FOOTER_LEGAL, FOOTER_MOBILE_GROUPS, FOOTER_SOCIAL } from './site-nav';

/**
 * Web/Language switch — "English · العربية". Sets the app's active locale, which
 * `LocaleDirectionProvider` turns into `lang`/`dir` on `<html>`, so Arabic mirrors the page.
 */
export function LanguageSwitch() {
  const t = useT();
  const locale = useActiveLocale();
  const arabic = locale.startsWith('ar');
  return (
    <div className="tm-web-lang" role="group" aria-label={t('WebFooter.language')}>
      <button
        type="button"
        className="tm-web-lang__option"
        lang="en"
        aria-pressed={!arabic}
        onClick={() => activeLocale.set('en-US')}
      >
        English
      </button>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        className="tm-web-lang__option"
        lang="ar"
        dir="rtl"
        aria-pressed={arabic}
        onClick={() => activeLocale.set('ar-EG')}
      >
        العربية
      </button>
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
              <p className="tm-web-footer__heading">{column.heading}</p>
              <ul className="tm-web-footer__links">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link href={link.href}>{link.label}</Link>
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
                {group.heading}
                <WebIcon name="plus" className="tm-web-accordion__plus" />
                <WebIcon name="minus" className="tm-web-accordion__minus" />
              </summary>
              <ul className="tm-web-footer__links tm-web-accordion__panel">
                {group.links.map((link) => (
                  <li key={link.label}>
                    <Link href={link.href}>{link.label}</Link>
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
            {FOOTER_LEGAL.map((link) => (
              <Link key={link.label} href={link.href}>
                {link.label}
              </Link>
            ))}
          </p>
          <ul className="tm-web-footer__social">
            {FOOTER_SOCIAL.map((item) => (
              <li key={item.label}>
                <a
                  href={item.href}
                  className="tm-web-orb tm-web-orb--outline tm-web-orb--default"
                  aria-label={item.label}
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
