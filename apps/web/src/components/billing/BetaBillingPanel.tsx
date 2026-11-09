'use client';

import Link from 'next/link';
import { Badge } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import { useOrganizationName } from '../../lib/use-organization-names';
import type { MessageKey } from '../../lib/i18n/t';
import '../../styles/screens/beta-billing.css';

/**
 * Billing during the public beta — approved Figma 419:9854. Everything is free while
 * `BILLING_MODE=beta_free` (the API's default): no plan to pick, no payment method, no upgrade or
 * checkout button. The plan-usage and subscription reads both carry `billingMode`, and both
 * screens show this panel instead of their paid content while it is `beta_free`.
 */

/** What the beta includes, as the right-hand card lists it. */
export const BETA_BILLING_INCLUDED: readonly MessageKey[] = [
  'BetaBilling.include1',
  'BetaBilling.include2',
  'BetaBilling.include3',
  'BetaBilling.include4',
  'BetaBilling.include5',
];

/** "Send feedback" opens the public contact page. */
export const BETA_FEEDBACK_HREF = '/contact';

function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, slot: string) =>
    values[slot] === undefined ? whole : String(values[slot]),
  );
}

/** The page title and line under it, for the screen's AppShell. */
export function useBetaBillingHeading(
  organizationSlug: string,
  organizationName: string,
): {
  title: string;
  description: string;
} {
  const t = useT();
  // FIX3 item 3 (live S1): the page hands over the design's sample name ("Northstar Studio");
  // the session's own organization list holds the real one.
  const name = useOrganizationName(organizationSlug, organizationName);
  return {
    title: t('BetaBilling.title'),
    description: fill(t('BetaBilling.lede'), { organization: name }),
  };
}

function CheckMark() {
  return (
    <svg
      className="tm-beta-billing__check"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 8.5 6.5 12 13 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BetaBillingPanel({ internalPeople }: { internalPeople: number }) {
  const t = useT();
  const tiles: readonly { labelKey: MessageKey; value: string }[] = [
    { labelKey: 'BetaBilling.planLabel', value: t('BetaBilling.planValue') },
    {
      labelKey: 'BetaBilling.peopleLabel',
      value: fill(t('BetaBilling.peopleValue'), { count: internalPeople }),
    },
    { labelKey: 'BetaBilling.clientsLabel', value: t('BetaBilling.clientsValue') },
    { labelKey: 'BetaBilling.invoiceLabel', value: t('BetaBilling.invoiceValue') },
  ];

  return (
    <div className="tm-beta-billing">
      <section className="tm-beta-billing__hero" aria-labelledby="tm-beta-billing-title">
        <Badge mono>{t('BetaBilling.badge')}</Badge>
        <h2 id="tm-beta-billing-title" className="tm-beta-billing__title">
          {t('BetaBilling.heroTitle')}
        </h2>
        <p className="tm-beta-billing__body">{t('BetaBilling.heroBody')}</p>
        <dl className="tm-beta-billing__tiles">
          {tiles.map((tile) => (
            <div key={tile.labelKey} className="tm-beta-billing__tile">
              <dt className="tm-beta-billing__label">{t(tile.labelKey)}</dt>
              <dd className="tm-beta-billing__value">{tile.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="tm-beta-billing__cards">
        <section className="tm-beta-billing__card" aria-labelledby="tm-beta-billing-after">
          <p className="tm-beta-billing__label">{t('BetaBilling.afterLabel')}</p>
          <h2 id="tm-beta-billing-after" className="tm-beta-billing__card-title">
            {t('BetaBilling.afterTitle')}
          </h2>
          <p className="tm-beta-billing__card-body">{t('BetaBilling.afterBody')}</p>
        </section>
        <section className="tm-beta-billing__card" aria-labelledby="tm-beta-billing-included">
          <h2 id="tm-beta-billing-included" className="tm-beta-billing__label">
            {t('BetaBilling.includedLabel')}
          </h2>
          <ul className="tm-beta-billing__list">
            {BETA_BILLING_INCLUDED.map((key) => (
              <li key={key} className="tm-beta-billing__item">
                <CheckMark />
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <p className="tm-beta-billing__foot">
        {t('BetaBilling.feedbackPrompt')}{' '}
        <Link href={BETA_FEEDBACK_HREF} className="tm-beta-billing__link">
          {t('BetaBilling.feedbackLink')}
        </Link>
      </p>
    </div>
  );
}
