import type { WebIconName } from './WebIcon';

/**
 * The website's navigation content — one source for the desktop mega menus, the mobile drawer
 * and the footer, so a page added to the site map is added once. Copy is SITE-SPEC.md §2 as
 * drawn in the approved "Website components" frame.
 */

export interface WebLink {
  label: string;
  href: string;
}

export interface WebMenuLink extends WebLink {
  hint: string;
  icon: WebIconName;
}

export interface WebMenuGroup {
  heading: string;
  links: readonly WebMenuLink[];
}

export interface WebFeatured {
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
  href: string;
  icon: WebIconName;
}

export interface WebMegaMenu {
  id: 'product' | 'solutions' | 'resources';
  label: string;
  groups: readonly WebMenuGroup[];
  featured: WebFeatured;
}

export type WebNavEntry =
  { kind: 'menu'; menu: WebMegaMenu } | { kind: 'link'; id: string; label: string; href: string };

export const PRODUCT_MENU: WebMegaMenu = {
  id: 'product',
  label: 'Product',
  groups: [
    {
      heading: 'Plan & deliver',
      links: [
        {
          label: 'Work & requests',
          hint: 'Every ask becomes owned work',
          href: '/features/work',
          icon: 'work',
        },
        {
          label: 'Projects & portfolio',
          hint: 'Milestones that move on evidence',
          href: '/features/work#projects',
          icon: 'flag',
        },
        {
          label: 'Automations',
          hint: 'Remove repeat coordination safely',
          href: '/features/insights#automations',
          icon: 'bolt',
        },
      ],
    },
    {
      heading: 'Talk & decide',
      links: [
        {
          label: 'Chat',
          hint: 'Threads that turn into tasks',
          href: '/features/communication',
          icon: 'chat',
        },
        {
          label: 'Calendar & meetings',
          hint: 'Meetings that end with owners',
          href: '/features/communication#calendar',
          icon: 'calendar',
        },
        {
          label: 'Docs & decisions',
          hint: 'Context beside the work',
          href: '/features/knowledge',
          icon: 'doc',
        },
      ],
    },
    {
      heading: 'Share with clients',
      links: [
        {
          label: 'Client portal',
          hint: 'A view clients understand in 30 seconds',
          href: '/client-portal',
          icon: 'portal',
        },
        {
          label: 'Approvals',
          hint: 'One decision, one exact version',
          href: '/features/knowledge#approvals',
          icon: 'check',
        },
        {
          label: 'Insights',
          hint: 'Health you can explain',
          href: '/features/insights',
          icon: 'chart',
        },
      ],
    },
  ],
  featured: {
    eyebrow: 'New · 4 min',
    title: 'See one request travel to approval',
    body: 'A short walkthrough, from the first ask to the approved version.',
    cta: 'Watch the work story',
    href: '/#work-story',
    icon: 'play',
  },
};

export const SOLUTIONS_MENU: WebMegaMenu = {
  id: 'solutions',
  label: 'Solutions',
  groups: [
    {
      heading: 'By team type',
      links: [
        {
          label: 'Agencies & studios',
          hint: 'Retainers and launches, many clients at once',
          href: '/solutions/agencies',
          icon: 'grid',
        },
        {
          label: 'Consultancies',
          hint: 'Engagements with decisions on record',
          href: '/solutions/consultancies',
          icon: 'briefcase',
        },
        {
          label: 'In-house teams',
          hint: 'Internal clients, the same clear delivery',
          href: '/solutions/in-house',
          icon: 'building',
        },
      ],
    },
    {
      heading: 'By role',
      links: [
        {
          label: 'Delivery leads',
          hint: 'See what is late before the client does',
          href: '/features/insights',
          icon: 'trend',
        },
        {
          label: 'Account managers',
          hint: 'Client updates without the chasing',
          href: '/client-portal',
          icon: 'person',
        },
        {
          label: 'Project managers',
          hint: 'Plans that stay true to the work',
          href: '/features/work',
          icon: 'list',
        },
      ],
    },
  ],
  featured: {
    eyebrow: 'Templates',
    title: 'Templates for client delivery',
    body: 'Start from a ready request-to-approval flow for your kind of team.',
    cta: 'Browse templates',
    href: '/resources#templates',
    icon: 'layers',
  },
};

export const RESOURCES_MENU: WebMegaMenu = {
  id: 'resources',
  label: 'Resources',
  groups: [
    {
      heading: 'Learn',
      links: [
        {
          label: 'Guides',
          hint: 'Step-by-step ways to run delivery',
          href: '/resources#guides',
          icon: 'book',
        },
        {
          label: 'Templates',
          hint: 'Flows you can start from today',
          href: '/resources#templates',
          icon: 'layers',
        },
        {
          label: 'Blog',
          hint: 'Notes on client work, done well',
          href: '/resources#blog',
          icon: 'pencil',
        },
      ],
    },
    {
      heading: 'Support',
      links: [
        {
          label: 'Help center',
          hint: 'Answers, setup and how-tos',
          href: '/faq',
          icon: 'help',
        },
        { label: 'Status', hint: 'Live system status and history', href: '/status', icon: 'pulse' },
        {
          label: 'Security',
          hint: 'How we protect client data',
          href: '/security',
          icon: 'shield',
        },
      ],
    },
  ],
  featured: {
    eyebrow: 'Playbook',
    title: 'The client approval playbook',
    body: 'How service teams get clear decisions from clients, on record, first time.',
    cta: 'Read the playbook',
    href: '/resources/client-approval-playbook',
    icon: 'book',
  },
};

export const NAV_ENTRIES: readonly WebNavEntry[] = [
  { kind: 'menu', menu: PRODUCT_MENU },
  { kind: 'menu', menu: SOLUTIONS_MENU },
  { kind: 'link', id: 'client-portal', label: 'Client portal', href: '/client-portal' },
  { kind: 'link', id: 'pricing', label: 'Pricing', href: '/pricing' },
  { kind: 'menu', menu: RESOURCES_MENU },
];

export const NAV_ACTIONS = {
  signIn: { label: 'Sign in', href: '/sign-in' },
  demo: { label: 'Book a demo', href: '/contact' },
  start: { label: 'Start free', href: '/sign-in' },
} as const;

export interface WebFooterColumn {
  heading: string;
  links: readonly WebLink[];
}

/** Desktop footer: seven balanced columns (Website components §09). */
export const FOOTER_COLUMNS: readonly WebFooterColumn[] = [
  {
    heading: 'Product',
    links: [
      { label: 'Overview', href: '/product' },
      { label: 'Work & requests', href: '/features/work' },
      { label: 'Projects & portfolio', href: '/features/work#projects' },
      { label: 'Automations', href: '/features/insights#automations' },
    ],
  },
  {
    heading: 'Collaborate',
    links: [
      { label: 'Chat', href: '/features/communication' },
      { label: 'Calendar', href: '/features/communication#calendar' },
      { label: 'Docs & decisions', href: '/features/knowledge' },
      { label: 'Insights', href: '/features/insights' },
    ],
  },
  {
    heading: 'Clients',
    links: [
      { label: 'Client portal', href: '/client-portal' },
      { label: 'Approvals', href: '/features/knowledge#approvals' },
      { label: 'Security for clients', href: '/security#clients' },
      { label: 'Portal demo', href: '/client-portal#demo' },
    ],
  },
  {
    heading: 'Solutions',
    links: [
      { label: 'Agencies & studios', href: '/solutions/agencies' },
      { label: 'Consultancies', href: '/solutions/consultancies' },
      { label: 'In-house teams', href: '/solutions/in-house' },
    ],
  },
  {
    heading: 'Resources',
    links: [
      { label: 'Blog', href: '/resources#blog' },
      { label: 'Guides', href: '/resources#guides' },
      { label: 'Templates', href: '/resources#templates' },
      { label: 'Help center', href: '/faq' },
      { label: 'Status', href: '/status' },
    ],
  },
  {
    heading: 'Company',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Customers', href: '/customers' },
      { label: 'Careers', href: '/about#careers' },
      { label: 'Contact sales', href: '/contact' },
      { label: 'Press kit', href: '/about#press' },
    ],
  },
  {
    heading: 'Trust',
    links: [
      { label: 'Security', href: '/security' },
      { label: 'Privacy', href: '/legal/privacy' },
      { label: 'Accessibility', href: '/security#accessibility' },
      { label: 'Sub-processors', href: '/security#sub-processors' },
      { label: 'Terms', href: '/legal/terms' },
    ],
  },
];

/** Mobile footer: six accordions; "Collaborate" folds into Product (Website components §03). */
export const FOOTER_MOBILE_GROUPS: readonly WebFooterColumn[] = [
  {
    heading: 'Product',
    links: [...FOOTER_COLUMNS[0]!.links, ...FOOTER_COLUMNS[1]!.links],
  },
  FOOTER_COLUMNS[2]!,
  FOOTER_COLUMNS[3]!,
  FOOTER_COLUMNS[4]!,
  FOOTER_COLUMNS[5]!,
  FOOTER_COLUMNS[6]!,
];

export const FOOTER_LEGAL: readonly WebLink[] = [
  { label: 'Privacy', href: '/legal/privacy' },
  { label: 'Terms', href: '/legal/terms' },
  { label: 'Cookie settings', href: '/legal/privacy' },
];

export const FOOTER_SOCIAL: readonly { label: string; href: string; icon: WebIconName }[] = [
  { label: 'TManage on LinkedIn', href: 'https://www.linkedin.com/', icon: 'linkedin' },
  { label: 'TManage on YouTube', href: 'https://www.youtube.com/', icon: 'video' },
  { label: 'Email TManage', href: '/contact', icon: 'mail' },
];
