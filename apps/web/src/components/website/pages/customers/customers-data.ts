import type { MessageKey } from '../../../../lib/i18n/t';
import type { WebIconName } from '../../index';

/**
 * Copy keys for `/customers` (SITE-SPEC "PAGE: Customers & stories"). Honesty rule: TManage has no
 * public customers yet, so every partner, story and quote is a marked placeholder until the
 * partner gives written consent. Outcomes are qualitative — no invented numbers.
 *
 * Every visible string is a catalog key resolved by `useT()` in `CustomersPage`, so the Arabic
 * page reads Arabic (live check 014a9d51, L10). The keys arrive through the i18n-L10 fragment;
 * `key()` keeps them typed as `MessageKey` until that fragment is merged into `en.json`.
 */
const key = (name: string): MessageKey => `CustomersPage.${name}` as MessageKey;

export type Segment = 'agencies' | 'consultancies' | 'in-house';

export const SEGMENT_LABEL: Record<Segment, MessageKey> = {
  agencies: key('segmentAgencies'),
  consultancies: key('segmentConsultancies'),
  'in-house': key('segmentInHouse'),
};

export const FILTERS: readonly { id: Segment | 'all'; labelKey: MessageKey }[] = [
  { id: 'all', labelKey: key('filterAll') },
  { id: 'agencies', labelKey: SEGMENT_LABEL.agencies },
  { id: 'consultancies', labelKey: SEGMENT_LABEL.consultancies },
  { id: 'in-house', labelKey: SEGMENT_LABEL['in-house'] },
];

export interface PartnerCopy {
  nameKey: MessageKey;
  kindKey: MessageKey;
  icon: WebIconName;
}

export const PARTNERS: readonly PartnerCopy[] = [
  { nameKey: key('partner01'), kindKey: key('kindAgency'), icon: 'building' },
  { nameKey: key('partner02'), kindKey: key('kindDesignStudio'), icon: 'pencil' },
  { nameKey: key('partner03'), kindKey: key('kindConsultancy'), icon: 'briefcase' },
  { nameKey: key('partner04'), kindKey: key('kindInHouse'), icon: 'person' },
  { nameKey: key('partner05'), kindKey: key('kindAgency'), icon: 'layers' },
  { nameKey: key('partner06'), kindKey: key('kindConsultancy'), icon: 'trend' },
];

export const FEATURED_OUTCOMES: readonly MessageKey[] = [
  key('outcomePortal'),
  key('outcomeFeedback'),
  key('outcomeWeek'),
];

/** The two deliverable cards in the hero stack. Owner names stay Latin: they are people. */
export const HERO_CARDS: readonly {
  titleKey: MessageKey;
  metaKey: MessageKey;
  tone: 'done' | 'current';
  stateKey: MessageKey;
  owner: string;
  primaryKey: MessageKey;
}[] = [
  {
    titleKey: key('heroCard1Title'),
    metaKey: key('heroCard1Meta'),
    tone: 'done',
    stateKey: key('stateApproved'),
    owner: 'Maya Hassan',
    primaryKey: key('heroCard1Primary'),
  },
  {
    titleKey: key('heroCard2Title'),
    metaKey: key('heroCard2Meta'),
    tone: 'current',
    stateKey: key('stateInProgress'),
    owner: 'Omar Adel',
    primaryKey: key('actionReview'),
  },
];

/** Copy for the inert client-portal mock in the featured story. */
export const PORTAL = {
  sub: key('portalSub'),
  badge: key('portalBadge'),
  eyebrow: key('portalEyebrow'),
  title: key('portalTitle'),
  body: key('portalBody'),
  stepDone: key('portalStepDiscovery'),
  stepCurrent: key('portalStepHomepage'),
  stepFuture: key('portalStepLaunch'),
  actions: key('portalActions'),
  cardTitle: key('portalCardTitle'),
  cardMeta: key('portalCardMeta'),
  cardState: key('portalCardState'),
  approve: key('actionApprove'),
  live: key('portalLive'),
  liveSub: key('portalLiveSub'),
} as const satisfies Record<string, MessageKey>;

/** Shared action label on every object card. */
export const ACTION_OPEN: MessageKey = key('actionOpen');

export interface Story {
  id: string;
  segment: Segment;
  titleKey: MessageKey;
  summaryKey: MessageKey;
  /** The "before → after" pair drawn as two state capsules on the card's visual. */
  beforeKey: MessageKey;
  afterKey: MessageKey;
}

function story(id: string, segment: Segment, stem: string): Story {
  return {
    id,
    segment,
    titleKey: key(`${stem}Title`),
    summaryKey: key(`${stem}Summary`),
    beforeKey: key(`${stem}Before`),
    afterKey: key(`${stem}After`),
  };
}

export const STORIES: readonly Story[] = [
  story('studio-approvals', 'agencies', 'storyApprovals'),
  story('consultancy-decisions', 'consultancies', 'storyDecisions'),
  story('in-house-requests', 'in-house', 'storyRequests'),
  story('bilingual-portal', 'agencies', 'storyBilingual'),
  story('committed-dates', 'consultancies', 'storyDates'),
  story('contractor-handover', 'in-house', 'storyHandover'),
];

export const QUOTES: readonly {
  id: string;
  quoteKey: MessageKey;
  authorKey: MessageKey;
  orgKey: MessageKey;
  tone?: 'paper' | 'ink';
}[] = [
  {
    id: 'studio-lead',
    quoteKey: key('quoteStudio'),
    authorKey: key('quoteStudioAuthor'),
    orgKey: key('quoteStudioOrg'),
  },
  {
    id: 'delivery-director',
    quoteKey: key('quoteDelivery'),
    authorKey: key('quoteDeliveryAuthor'),
    orgKey: key('quoteDeliveryOrg'),
    tone: 'ink',
  },
  {
    id: 'operations-manager',
    quoteKey: key('quoteOperations'),
    authorKey: key('quoteOperationsAuthor'),
    orgKey: key('quoteOperationsOrg'),
  },
];

export const PROGRAMME_BENEFITS: readonly {
  icon: WebIconName;
  titleKey: MessageKey;
  bodyKey: MessageKey;
}[] = [
  { icon: 'trend', titleKey: key('benefitRoadmap'), bodyKey: key('benefitRoadmapBody') },
  { icon: 'layers', titleKey: key('benefitEarly'), bodyKey: key('benefitEarlyBody') },
  { icon: 'help', titleKey: key('benefitSupport'), bodyKey: key('benefitSupportBody') },
  { icon: 'shield', titleKey: key('benefitStory'), bodyKey: key('benefitStoryBody') },
];
