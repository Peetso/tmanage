import type { LogoStripPartner, TestimonialCardProps, WebIconName } from '../../index';

/**
 * Copy for `/customers` (SITE-SPEC "PAGE: Customers & stories"). Honesty rule: TManage has no
 * public customers yet, so every partner, story and quote is a marked placeholder until the
 * partner gives written consent. Outcomes are qualitative — no invented numbers.
 */

export type Segment = 'agencies' | 'consultancies' | 'in-house';

export const SEGMENT_LABEL: Record<Segment, string> = {
  agencies: 'Agencies & studios',
  consultancies: 'Consultancies',
  'in-house': 'In-house teams',
};

export const FILTERS: readonly { id: Segment | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'agencies', label: SEGMENT_LABEL.agencies },
  { id: 'consultancies', label: SEGMENT_LABEL.consultancies },
  { id: 'in-house', label: SEGMENT_LABEL['in-house'] },
];

export const PARTNERS: readonly LogoStripPartner[] = [
  { name: 'Design partner 01', kind: 'Agency', icon: 'building' },
  { name: 'Design partner 02', kind: 'Design studio', icon: 'pencil' },
  { name: 'Design partner 03', kind: 'Consultancy', icon: 'briefcase' },
  { name: 'Design partner 04', kind: 'In-house team', icon: 'person' },
  { name: 'Design partner 05', kind: 'Agency', icon: 'layers' },
  { name: 'Design partner 06', kind: 'Consultancy', icon: 'trend' },
];

export const FEATURED_OUTCOMES: readonly string[] = [
  'Clients check progress in the portal instead of waiting for Friday.',
  'Feedback lands on the exact version it is about.',
  'The team starts the week knowing what was promised, not guessed.',
];

export interface Story {
  id: string;
  segment: Segment;
  title: string;
  summary: string;
  /** The "before → after" pair drawn as two state capsules on the card's visual. */
  before: string;
  after: string;
}

export const STORIES: readonly Story[] = [
  {
    id: 'studio-approvals',
    segment: 'agencies',
    title: 'A studio that stopped chasing approvals by email',
    summary: 'Approvals now point at one file and one decision.',
    before: 'Email chases',
    after: 'One link',
  },
  {
    id: 'consultancy-decisions',
    segment: 'consultancies',
    title: 'A consultancy that keeps every decision on the record',
    summary: 'Decisions carry their context, so handovers stop losing it.',
    before: 'Lost in calls',
    after: 'On the record',
  },
  {
    id: 'in-house-requests',
    segment: 'in-house',
    title: 'An in-house team that answers the business in one place',
    summary: 'Requests arrive as requests, with an owner from day one.',
    before: 'Five tools',
    after: 'One queue',
  },
  {
    id: 'bilingual-portal',
    segment: 'agencies',
    title: 'A bilingual client portal, in Arabic and English',
    summary: 'Clients review in their own language, right to left.',
    before: 'Two portals',
    after: 'One portal',
  },
  {
    id: 'committed-dates',
    segment: 'consultancies',
    title: 'From desired dates to committed ones',
    summary: 'Clients see what is promised, apart from what is hoped.',
    before: 'Desired dates',
    after: 'Committed',
  },
  {
    id: 'contractor-handover',
    segment: 'in-house',
    title: 'Handing over a contractor’s work without loose ends',
    summary: 'Access, ownership and shares move in one guided flow.',
    before: 'Loose ends',
    after: 'Clean handover',
  },
];

export const QUOTES: readonly (TestimonialCardProps & { id: string })[] = [
  {
    id: 'studio-lead',
    quote: 'The client opens the portal before they think of calling us.',
    author: 'Studio lead',
    org: 'Agency · Design partner',
  },
  {
    id: 'delivery-director',
    quote: 'Every approval points at one version. Nobody asks which file anymore.',
    author: 'Delivery director',
    org: 'Consultancy · Design partner',
    tone: 'ink',
  },
  {
    id: 'operations-manager',
    quote: 'Requests finally have an owner from the moment they arrive.',
    author: 'Operations manager',
    org: 'In-house team · Design partner',
  },
];

export const PROGRAMME_BENEFITS: readonly { icon: WebIconName; title: string; body: string }[] = [
  {
    icon: 'trend',
    title: 'Shape the roadmap',
    body: 'Your workflow informs what we build next.',
  },
  { icon: 'layers', title: 'Early access', body: 'Try new features before everyone else.' },
  { icon: 'help', title: 'Direct support', body: 'A named contact on our product team.' },
  { icon: 'shield', title: 'Your story, your call', body: 'We publish only what you approve.' },
];
