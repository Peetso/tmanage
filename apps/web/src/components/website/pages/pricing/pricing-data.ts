/**
 * Pricing page copy (SITE-SPEC "PAGE: Pricing", as drawn in the approved 11-pricing design).
 * Prices are not set before paid beta, so every plan shows "$ —" and the launch-price note.
 */

export type BillingPeriod = 'monthly' | 'yearly';

export interface PricingPlan {
  id: 'free' | 'starter' | 'studio' | 'business' | 'enterprise';
  name: string;
  positioning: string;
  cta: { label: string; href: string };
  features: readonly string[];
  /** Studio: the lime-bordered "Most teams start here" card with the lime CTA. */
  featured?: boolean;
  /** Enterprise: the ink card. */
  ink?: boolean;
}

export const PRICING_PLANS: readonly PricingPlan[] = [
  {
    id: 'free',
    name: 'Free',
    positioning: 'For a small team trying TManage on real client work.',
    cta: { label: 'Start free', href: '/sign-in' },
    features: [
      'Up to 3 internal seats',
      'Unlimited clients',
      'Work, chat and calendar',
      'One client portal',
    ],
  },
  {
    id: 'starter',
    name: 'Starter',
    positioning: 'For small teams moving their projects off spreadsheets.',
    cta: { label: 'Choose Starter', href: '/sign-in' },
    features: [
      'Everything in Free',
      'Unlimited projects',
      'Requests and approvals',
      'Branded client portal',
    ],
  },
  {
    id: 'studio',
    name: 'Studio',
    positioning: 'For agencies running many clients and projects at once.',
    cta: { label: 'Choose Studio', href: '/sign-in' },
    features: ['Everything in Starter', 'Docs and decisions', 'Workload insights', 'Automations'],
    featured: true,
  },
  {
    id: 'business',
    name: 'Business',
    positioning: 'For firms that need control, roles and reporting across teams.',
    cta: { label: 'Choose Business', href: '/sign-in' },
    features: ['Everything in Studio', 'Roles and permissions', 'Audit log', 'Priority support'],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    positioning: 'For large teams with security reviews and contracts.',
    cta: { label: 'Contact sales', href: '/contact' },
    features: ['Everything in Business', 'SSO and SCIM', 'Data residency', 'Named success lead'],
    ink: true,
  },
];

/** A comparison cell: included, not included, or a short word ("Limited", "Add-on", "Contract"). */
export type CompareCell = true | false | string;

export interface CompareGroup {
  category: string;
  rows: readonly { feature: string; cells: readonly CompareCell[] }[];
}

export const COMPARE_GROUPS: readonly CompareGroup[] = [
  {
    category: 'Work & projects',
    rows: [
      { feature: 'Projects and tasks', cells: [true, true, true, true, true] },
      { feature: 'Request intake', cells: ['Limited', true, true, true, true] },
    ],
  },
  {
    category: 'Chat & calendar',
    rows: [
      { feature: 'Team chat', cells: [true, true, true, true, true] },
      { feature: 'Shared calendars', cells: ['Limited', true, true, true, true] },
    ],
  },
  {
    category: 'Docs & approvals',
    rows: [
      { feature: 'Docs and decisions', cells: ['Limited', 'Limited', true, true, true] },
      { feature: 'Client approvals', cells: [false, true, true, true, true] },
    ],
  },
  {
    category: 'Client portal',
    rows: [
      { feature: 'Client seats', cells: [true, true, true, true, true] },
      { feature: 'Portal branding', cells: [false, true, true, true, true] },
    ],
  },
  {
    category: 'Insights & automations',
    rows: [
      { feature: 'Workload insights', cells: [false, false, true, true, true] },
      { feature: 'Automations', cells: [false, 'Limited', true, true, true] },
    ],
  },
  {
    category: 'Security & admin',
    rows: [
      { feature: 'SSO and SCIM', cells: [false, false, false, 'Add-on', true] },
      { feature: 'Data residency', cells: [false, false, false, 'Add-on', 'Contract'] },
    ],
  },
];

export const PRICING_FAQ: readonly { question: string; answer: string }[] = [
  {
    question: 'Who counts as a seat?',
    answer:
      'Anyone on your team with an internal login. Clients, guests and approvers never use a seat.',
  },
  {
    question: 'Why is there no price yet?',
    answer:
      'TManage is still in private build. Prices are set when paid beta opens, and early teams keep their launch price.',
  },
  {
    question: 'Can I switch plans later?',
    answer: 'Yes. Move up or down at any time. The change applies from your next billing period.',
  },
  {
    question: 'What stays free on the Free plan?',
    answer:
      'Up to three internal seats, unlimited clients and one client portal, with no time limit.',
  },
  {
    question: 'Is yearly billing cheaper?',
    answer:
      'Yes. Yearly billing will cost less than twelve monthly payments. The exact saving is confirmed at paid beta.',
  },
  {
    question: 'How is Enterprise priced?',
    answer:
      'Enterprise is quoted per contract, based on seats, security review and data residency needs.',
  },
];
