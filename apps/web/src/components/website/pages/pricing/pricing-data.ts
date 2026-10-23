import { SIGN_UP_HREF } from '../../../../lib/public-signup';
/**
 * Pricing page data (approved Figma section 376:2087, frames pr-desktop / pr-mobile).
 * Flat prices for the whole team — never per seat — with yearly billing at −20 %.
 * The words themselves live in the i18n catalogs; this file holds only keys, prices, links and flags.
 */

export type BillingPeriod = 'monthly' | 'yearly';

/** A pricing catalog key: every visible word comes from `en.json`/`ar.json` under `PricingPage.*`. */
export type PricingKey = `PricingPage.${string}`;

/** Yearly billing saves 20 %: the yearly price per month is the monthly price × 0.8. */
export const YEARLY_FACTOR = 0.8;

export interface PricingPlan {
  id: 'free' | 'starter' | 'studio' | 'business' | 'enterprise';
  /** The tier name. English and Arabic both show the Latin name (Arabic prefixes U+200F). */
  nameKey: PricingKey;
  positioningKey: PricingKey;
  /** Flat monthly price for the whole team in US cents; `null` is Enterprise's custom quote. */
  monthlyCents: number | null;
  cta: { labelKey: PricingKey; href: string };
  featureKeys: readonly PricingKey[];
  /** Studio: the lime-bordered "Most teams start here" card with the lime CTA. */
  featured?: boolean;
  /** Enterprise: the ink card. */
  ink?: boolean;
}

export const PRICING_PLANS: readonly PricingPlan[] = [
  {
    id: 'free',
    nameKey: 'PricingPage.planFreeName',
    positioningKey: 'PricingPage.flatFreePositioning',
    monthlyCents: 0,
    cta: { labelKey: 'PricingPage.planFreeCta', href: SIGN_UP_HREF },
    featureKeys: [
      'PricingPage.flatFreeFeature1',
      'PricingPage.flatFreeFeature2',
      'PricingPage.flatFreeFeature3',
      'PricingPage.flatFreeFeature4',
    ],
  },
  {
    id: 'starter',
    nameKey: 'PricingPage.planStarterName',
    positioningKey: 'PricingPage.flatStarterPositioning',
    monthlyCents: 1900,
    cta: { labelKey: 'PricingPage.planStarterCta', href: SIGN_UP_HREF },
    featureKeys: [
      'PricingPage.flatStarterFeature1',
      'PricingPage.flatStarterFeature2',
      'PricingPage.flatStarterFeature3',
      'PricingPage.flatStarterFeature4',
    ],
  },
  {
    id: 'studio',
    nameKey: 'PricingPage.planStudioName',
    positioningKey: 'PricingPage.flatStudioPositioning',
    monthlyCents: 4900,
    cta: { labelKey: 'PricingPage.planStudioCta', href: SIGN_UP_HREF },
    featureKeys: [
      'PricingPage.flatStudioFeature1',
      'PricingPage.flatStudioFeature2',
      'PricingPage.flatStudioFeature3',
      'PricingPage.flatStudioFeature4',
    ],
    featured: true,
  },
  {
    id: 'business',
    nameKey: 'PricingPage.planBusinessName',
    positioningKey: 'PricingPage.flatBusinessPositioning',
    monthlyCents: 8900,
    cta: { labelKey: 'PricingPage.planBusinessCta', href: SIGN_UP_HREF },
    featureKeys: [
      'PricingPage.flatBusinessFeature1',
      'PricingPage.flatBusinessFeature2',
      'PricingPage.flatBusinessFeature3',
      'PricingPage.flatBusinessFeature4',
    ],
  },
  {
    id: 'enterprise',
    nameKey: 'PricingPage.planEnterpriseName',
    positioningKey: 'PricingPage.flatEnterprisePositioning',
    monthlyCents: null,
    cta: { labelKey: 'PricingPage.planEnterpriseCta', href: '/contact' },
    featureKeys: [
      'PricingPage.flatEnterpriseFeature1',
      'PricingPage.flatEnterpriseFeature2',
      'PricingPage.flatEnterpriseFeature3',
      'PricingPage.flatEnterpriseFeature4',
    ],
    ink: true,
  },
];

/** `$19` for whole dollars, `$15.20` otherwise — the two forms the design draws. */
export function formatUsd(cents: number, decimals: 'auto' | 'always' = 'auto'): string {
  const dollars = cents / 100;
  const whole = Number.isInteger(dollars) && decimals === 'auto';
  return `$${whole ? dollars.toFixed(0) : dollars.toFixed(2)}`;
}

export interface PlanPrice {
  /** The big figure: per month at the chosen period ($19 monthly, $15.20 yearly). */
  perMonth: string;
  /** The whole year billed yearly ($182.40). */
  perYear: string;
  /** The monthly-billed price ($19). */
  monthly: string;
  /** The yearly-billed price per month ($15.20). */
  yearlyPerMonth: string;
}

/** The figures a paid card shows. Cents are rounded once, so ×0.8 never drifts a cent. */
export function planPrice(monthlyCents: number, period: BillingPeriod): PlanPrice {
  const yearlyMonthCents = Math.round(monthlyCents * YEARLY_FACTOR);
  const yearlyPerMonth = formatUsd(yearlyMonthCents, 'always');
  const monthly = formatUsd(monthlyCents);
  return {
    perMonth: period === 'yearly' ? yearlyPerMonth : monthly,
    perYear: formatUsd(yearlyMonthCents * 12, 'always'),
    monthly,
    yearlyPerMonth,
  };
}

export const PRICING_FAQ: readonly { questionKey: PricingKey; answerKey: PricingKey }[] = [
  { questionKey: 'PricingPage.faqPersonQuestion', answerKey: 'PricingPage.faqPersonAnswer' },
  { questionKey: 'PricingPage.faqFoundingQuestion', answerKey: 'PricingPage.faqFoundingAnswer' },
  { questionKey: 'PricingPage.faqSwitchQuestion', answerKey: 'PricingPage.faqSwitchAnswer' },
  { questionKey: 'PricingPage.faqFreePlanQuestion', answerKey: 'PricingPage.faqFreePlanAnswer' },
];
