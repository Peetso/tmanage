import type { MessageKey } from '../../lib/i18n/t';
import type { WebIconName } from './WebIcon';

/**
 * The website's navigation content — one source for the desktop mega menus, the mobile drawer
 * and the footer, so a page added to the site map is added once. Copy is SITE-SPEC.md §2 as
 * drawn in the approved "Website components" frame. Every visible string is a {@link MessageKey};
 * WebNav, MegaMenu and WebFooter resolve it with `t()` so the chrome follows the active locale.
 */

export interface WebLink {
  label: MessageKey;
  href: string;
}

export interface WebMenuLink extends WebLink {
  hint: MessageKey;
  icon: WebIconName;
}

export interface WebMenuGroup {
  heading: MessageKey;
  links: readonly WebMenuLink[];
}

export interface WebFeatured {
  eyebrow: MessageKey;
  title: MessageKey;
  body: MessageKey;
  cta: MessageKey;
  href: string;
  icon: WebIconName;
}

export interface WebMegaMenu {
  id: 'product' | 'solutions' | 'resources';
  label: MessageKey;
  groups: readonly WebMenuGroup[];
  featured: WebFeatured;
}

export type WebNavEntry =
  | { kind: 'menu'; menu: WebMegaMenu }
  | {
      kind: 'link';
      id: string;
      label: MessageKey;
      href: string;
      /** Drawn as the lime-subtle capsule (Figma 412:6686 "Nav · Desktop app"). */
      accent?: true;
    };

/** Where the site's desktop-app links land: the download page (PUB-03, Figma 443:20300). */
export const DESKTOP_APP_HREF = '/download';

export const PRODUCT_MENU: WebMegaMenu = {
  id: 'product',
  label: 'SiteNav.product',
  groups: [
    {
      heading: 'SiteNav.planDeliver',
      links: [
        {
          label: 'SiteNav.workRequests',
          hint: 'SiteNav.workRequestsHint',
          href: '/features/work',
          icon: 'work',
        },
        {
          label: 'SiteNav.projectsPortfolio',
          hint: 'SiteNav.projectsPortfolioHint',
          href: '/features/work#projects',
          icon: 'flag',
        },
        {
          label: 'SiteNav.automations',
          hint: 'SiteNav.automationsHint',
          href: '/features/insights#automations',
          icon: 'bolt',
        },
      ],
    },
    {
      heading: 'SiteNav.talkDecide',
      links: [
        {
          label: 'SiteNav.chat',
          hint: 'SiteNav.chatHint',
          href: '/features/communication',
          icon: 'chat',
        },
        {
          label: 'SiteNav.calendarMeetings',
          hint: 'SiteNav.calendarMeetingsHint',
          href: '/features/communication#calendar',
          icon: 'calendar',
        },
        {
          label: 'SiteNav.docsDecisions',
          hint: 'SiteNav.docsDecisionsHint',
          href: '/features/knowledge',
          icon: 'doc',
        },
      ],
    },
    {
      heading: 'SiteNav.shareWithClients',
      links: [
        {
          label: 'SiteNav.clientPortal',
          hint: 'SiteNav.clientPortalHint',
          href: '/client-portal',
          icon: 'portal',
        },
        {
          label: 'SiteNav.approvals',
          hint: 'SiteNav.approvalsHint',
          href: '/features/knowledge#approvals',
          icon: 'check',
        },
        {
          label: 'SiteNav.insights',
          hint: 'SiteNav.insightsHint',
          href: '/features/insights',
          icon: 'chart',
        },
      ],
    },
  ],
  featured: {
    eyebrow: 'SiteNav.productFeaturedEyebrow',
    title: 'SiteNav.productFeaturedTitle',
    body: 'SiteNav.productFeaturedBody',
    cta: 'SiteNav.productFeaturedCta',
    href: '/#work-story',
    icon: 'play',
  },
};

export const SOLUTIONS_MENU: WebMegaMenu = {
  id: 'solutions',
  label: 'SiteNav.solutions',
  groups: [
    {
      heading: 'SiteNav.byTeamType',
      links: [
        {
          label: 'SiteNav.agencies',
          hint: 'SiteNav.agenciesHint',
          href: '/solutions/agencies',
          icon: 'grid',
        },
        {
          label: 'SiteNav.consultancies',
          hint: 'SiteNav.consultanciesHint',
          href: '/solutions/consultancies',
          icon: 'briefcase',
        },
        {
          label: 'SiteNav.inHouse',
          hint: 'SiteNav.inHouseHint',
          href: '/solutions/in-house',
          icon: 'building',
        },
      ],
    },
    {
      heading: 'SiteNav.byRole',
      links: [
        {
          label: 'SiteNav.deliveryLeads',
          hint: 'SiteNav.deliveryLeadsHint',
          href: '/features/insights',
          icon: 'trend',
        },
        {
          label: 'SiteNav.accountManagers',
          hint: 'SiteNav.accountManagersHint',
          href: '/client-portal',
          icon: 'person',
        },
        {
          label: 'SiteNav.projectManagers',
          hint: 'SiteNav.projectManagersHint',
          href: '/features/work',
          icon: 'list',
        },
      ],
    },
  ],
  featured: {
    eyebrow: 'SiteNav.templates',
    title: 'SiteNav.solutionsFeaturedTitle',
    body: 'SiteNav.solutionsFeaturedBody',
    cta: 'SiteNav.solutionsFeaturedCta',
    href: '/resources#templates',
    icon: 'layers',
  },
};

export const RESOURCES_MENU: WebMegaMenu = {
  id: 'resources',
  label: 'SiteNav.resources',
  groups: [
    {
      heading: 'SiteNav.learn',
      links: [
        {
          label: 'SiteNav.guides',
          hint: 'SiteNav.guidesHint',
          href: '/resources#guides',
          icon: 'book',
        },
        {
          label: 'SiteNav.templates',
          hint: 'SiteNav.templatesHint',
          href: '/resources#templates',
          icon: 'layers',
        },
        {
          label: 'SiteNav.blog',
          hint: 'SiteNav.blogHint',
          href: '/resources#blog',
          icon: 'pencil',
        },
      ],
    },
    {
      heading: 'SiteNav.support',
      links: [
        {
          label: 'SiteNav.helpCenter',
          hint: 'SiteNav.helpCenterHint',
          href: '/faq',
          icon: 'help',
        },
        { label: 'SiteNav.status', hint: 'SiteNav.statusHint', href: '/status', icon: 'pulse' },
        {
          label: 'SiteNav.security',
          hint: 'SiteNav.securityHint',
          href: '/security',
          icon: 'shield',
        },
      ],
    },
  ],
  featured: {
    eyebrow: 'SiteNav.resourcesFeaturedEyebrow',
    title: 'SiteNav.resourcesFeaturedTitle',
    body: 'SiteNav.resourcesFeaturedBody',
    cta: 'SiteNav.resourcesFeaturedCta',
    href: '/resources/client-approval-playbook',
    icon: 'book',
  },
};

export const NAV_ENTRIES: readonly WebNavEntry[] = [
  { kind: 'menu', menu: PRODUCT_MENU },
  { kind: 'menu', menu: SOLUTIONS_MENU },
  { kind: 'link', id: 'client-portal', label: 'SiteNav.clientPortal', href: '/client-portal' },
  { kind: 'link', id: 'pricing', label: 'SiteNav.pricing', href: '/pricing' },
  { kind: 'menu', menu: RESOURCES_MENU },
  {
    kind: 'link',
    id: 'desktop-app',
    // The key ships as a wave fragment; the cast holds until it reaches `en.json`.
    label: 'SiteNav.desktopApp' as MessageKey,
    href: DESKTOP_APP_HREF,
    accent: true,
  },
];

export const NAV_ACTIONS = {
  signIn: { label: 'SiteNav.signIn', href: '/sign-in' },
  demo: { label: 'SiteNav.bookDemo', href: '/contact' },
  start: { label: 'SiteNav.startFree', href: '/sign-in' },
} as const;

export interface WebFooterColumn {
  heading: MessageKey;
  links: readonly WebLink[];
}

/** Desktop footer: seven balanced columns (Website components §09). */
export const FOOTER_COLUMNS: readonly WebFooterColumn[] = [
  {
    heading: 'SiteNav.product',
    links: [
      { label: 'SiteNav.overview', href: '/product' },
      { label: 'SiteNav.workRequests', href: '/features/work' },
      { label: 'SiteNav.projectsPortfolio', href: '/features/work#projects' },
      { label: 'SiteNav.automations', href: '/features/insights#automations' },
    ],
  },
  {
    heading: 'SiteNav.collaborate',
    links: [
      { label: 'SiteNav.chat', href: '/features/communication' },
      { label: 'SiteNav.calendar', href: '/features/communication#calendar' },
      { label: 'SiteNav.docsDecisions', href: '/features/knowledge' },
      { label: 'SiteNav.insights', href: '/features/insights' },
    ],
  },
  {
    heading: 'SiteNav.clients',
    links: [
      { label: 'SiteNav.clientPortal', href: '/client-portal' },
      { label: 'SiteNav.approvals', href: '/features/knowledge#approvals' },
      { label: 'SiteNav.securityForClients', href: '/security#clients' },
      { label: 'SiteNav.portalDemo', href: '/client-portal#demo' },
    ],
  },
  {
    heading: 'SiteNav.solutions',
    links: [
      { label: 'SiteNav.agencies', href: '/solutions/agencies' },
      { label: 'SiteNav.consultancies', href: '/solutions/consultancies' },
      { label: 'SiteNav.inHouse', href: '/solutions/in-house' },
    ],
  },
  {
    heading: 'SiteNav.resources',
    links: [
      { label: 'SiteNav.blog', href: '/resources#blog' },
      { label: 'SiteNav.guides', href: '/resources#guides' },
      { label: 'SiteNav.templates', href: '/resources#templates' },
      { label: 'SiteNav.helpCenter', href: '/faq' },
      { label: 'SiteNav.status', href: '/status' },
    ],
  },
  {
    heading: 'SiteNav.company',
    links: [
      { label: 'SiteNav.about', href: '/about' },
      { label: 'SiteNav.customers', href: '/customers' },
      { label: 'SiteNav.careers', href: '/about#careers' },
      { label: 'SiteNav.contactSales', href: '/contact' },
      { label: 'SiteNav.pressKit', href: '/about#press' },
    ],
  },
  {
    heading: 'SiteNav.trust',
    links: [
      { label: 'SiteNav.security', href: '/security' },
      { label: 'SiteNav.privacy', href: '/legal/privacy' },
      { label: 'SiteNav.accessibility', href: '/security#accessibility' },
      { label: 'SiteNav.subProcessors', href: '/security/data-location#subprocessors' },
      { label: 'SiteNav.terms', href: '/legal/terms' },
    ],
  },
];

/** Mobile footer: six accordions; "Collaborate" folds into Product (Website components §03). */
export const FOOTER_MOBILE_GROUPS: readonly WebFooterColumn[] = [
  {
    heading: 'SiteNav.product',
    links: [...FOOTER_COLUMNS[0]!.links, ...FOOTER_COLUMNS[1]!.links],
  },
  FOOTER_COLUMNS[2]!,
  FOOTER_COLUMNS[3]!,
  FOOTER_COLUMNS[4]!,
  FOOTER_COLUMNS[5]!,
  FOOTER_COLUMNS[6]!,
];

export const FOOTER_LEGAL: readonly WebLink[] = [
  { label: 'SiteNav.privacy', href: '/legal/privacy' },
  { label: 'SiteNav.terms', href: '/legal/terms' },
  { label: 'SiteNav.cookieSettings', href: '/legal/privacy' },
];

export const FOOTER_SOCIAL: readonly { label: MessageKey; href: string; icon: WebIconName }[] = [
  { label: 'SiteNav.socialEmail', href: '/contact', icon: 'mail' },
];
