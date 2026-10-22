import { SIGN_UP_HREF } from '../../../../lib/public-signup';
/**
 * Pricing page copy (SITE-SPEC "PAGE: Pricing", as drawn in the approved 11-pricing design).
 * Prices are not set before paid beta, so every plan shows "$ —" and the launch-price note.
 * The words themselves live in the i18n catalogs; this file holds only keys, links and flags.
 */

export type BillingPeriod = 'monthly' | 'yearly';

/**
 * A pricing catalog key. Every visible word on the plan cards, the comparison table and the FAQ
 * comes from `en.json`/`ar.json` under `PricingPage.*`, so the Arabic page never falls back to the
 * English copy (live check 014a9d51, report lines 106-107).
 */
export type PricingKey = `PricingPage.${string}`;

export interface PricingPlan {
  id: 'free' | 'starter' | 'studio' | 'business' | 'enterprise';
  /** The tier name. English and Arabic both show the Latin name (Arabic prefixes U+200F). */
  nameKey: PricingKey;
  positioningKey: PricingKey;
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
    positioningKey: 'PricingPage.planFreePositioning',
    cta: { labelKey: 'PricingPage.planFreeCta', href: SIGN_UP_HREF },
    featureKeys: [
      'PricingPage.planFreeFeature1',
      'PricingPage.planFreeFeature2',
      'PricingPage.planFreeFeature3',
      'PricingPage.planFreeFeature4',
    ],
  },
  {
    id: 'starter',
    nameKey: 'PricingPage.planStarterName',
    positioningKey: 'PricingPage.planStarterPositioning',
    cta: { labelKey: 'PricingPage.planStarterCta', href: SIGN_UP_HREF },
    featureKeys: [
      'PricingPage.planStarterFeature1',
      'PricingPage.planStarterFeature2',
      'PricingPage.planStarterFeature3',
      'PricingPage.planStarterFeature4',
    ],
  },
  {
    id: 'studio',
    nameKey: 'PricingPage.planStudioName',
    positioningKey: 'PricingPage.planStudioPositioning',
    cta: { labelKey: 'PricingPage.planStudioCta', href: SIGN_UP_HREF },
    featureKeys: [
      'PricingPage.planStudioFeature1',
      'PricingPage.planStudioFeature2',
      'PricingPage.planStudioFeature3',
      'PricingPage.planStudioFeature4',
    ],
    featured: true,
  },
  {
    id: 'business',
    nameKey: 'PricingPage.planBusinessName',
    positioningKey: 'PricingPage.planBusinessPositioning',
    cta: { labelKey: 'PricingPage.planBusinessCta', href: SIGN_UP_HREF },
    featureKeys: [
      'PricingPage.planBusinessFeature1',
      'PricingPage.planBusinessFeature2',
      'PricingPage.planBusinessFeature3',
      'PricingPage.planBusinessFeature4',
    ],
  },
  {
    id: 'enterprise',
    nameKey: 'PricingPage.planEnterpriseName',
    positioningKey: 'PricingPage.planEnterprisePositioning',
    cta: { labelKey: 'PricingPage.planEnterpriseCta', href: '/contact' },
    featureKeys: [
      'PricingPage.planEnterpriseFeature1',
      'PricingPage.planEnterpriseFeature2',
      'PricingPage.planEnterpriseFeature3',
      'PricingPage.planEnterpriseFeature4',
    ],
    ink: true,
  },
];

/** A comparison cell: included, not included, or a short word ("Limited", "Add-on", "Contract"). */
export type CompareCell = true | false | PricingKey;

const LIMITED: PricingKey = 'PricingPage.cellLimited';
const ADD_ON: PricingKey = 'PricingPage.cellAddOn';
const CONTRACT: PricingKey = 'PricingPage.cellContract';

export interface CompareGroup {
  categoryKey: PricingKey;
  rows: readonly { featureKey: PricingKey; cells: readonly CompareCell[] }[];
}

export const COMPARE_GROUPS: readonly CompareGroup[] = [
  {
    categoryKey: 'PricingPage.compareCatWork',
    rows: [
      { featureKey: 'PricingPage.compareRowProjects', cells: [true, true, true, true, true] },
      { featureKey: 'PricingPage.compareRowIntake', cells: [LIMITED, true, true, true, true] },
    ],
  },
  {
    categoryKey: 'PricingPage.compareCatChat',
    rows: [
      { featureKey: 'PricingPage.compareRowChat', cells: [true, true, true, true, true] },
      { featureKey: 'PricingPage.compareRowCalendars', cells: [LIMITED, true, true, true, true] },
    ],
  },
  {
    categoryKey: 'PricingPage.compareCatDocs',
    rows: [
      { featureKey: 'PricingPage.compareRowDocs', cells: [LIMITED, LIMITED, true, true, true] },
      { featureKey: 'PricingPage.compareRowApprovals', cells: [false, true, true, true, true] },
    ],
  },
  {
    categoryKey: 'PricingPage.compareCatPortal',
    rows: [
      { featureKey: 'PricingPage.compareRowClientSeats', cells: [true, true, true, true, true] },
      { featureKey: 'PricingPage.compareRowBranding', cells: [false, true, true, true, true] },
    ],
  },
  {
    categoryKey: 'PricingPage.compareCatInsights',
    rows: [
      { featureKey: 'PricingPage.compareRowInsights', cells: [false, false, true, true, true] },
      {
        featureKey: 'PricingPage.compareRowAutomations',
        cells: [false, LIMITED, true, true, true],
      },
    ],
  },
  {
    categoryKey: 'PricingPage.compareCatSecurity',
    rows: [
      { featureKey: 'PricingPage.compareRowSso', cells: [false, false, false, ADD_ON, true] },
      {
        featureKey: 'PricingPage.compareRowResidency',
        cells: [false, false, false, ADD_ON, CONTRACT],
      },
    ],
  },
];

export const PRICING_FAQ: readonly { questionKey: PricingKey; answerKey: PricingKey }[] = [
  { questionKey: 'PricingPage.faqSeatQuestion', answerKey: 'PricingPage.faqSeatAnswer' },
  { questionKey: 'PricingPage.faqNoPriceQuestion', answerKey: 'PricingPage.faqNoPriceAnswer' },
  { questionKey: 'PricingPage.faqSwitchQuestion', answerKey: 'PricingPage.faqSwitchAnswer' },
  { questionKey: 'PricingPage.faqFreeQuestion', answerKey: 'PricingPage.faqFreeAnswer' },
  { questionKey: 'PricingPage.faqYearlyQuestion', answerKey: 'PricingPage.faqYearlyAnswer' },
  {
    questionKey: 'PricingPage.faqEnterpriseQuestion',
    answerKey: 'PricingPage.faqEnterpriseAnswer',
  },
];
