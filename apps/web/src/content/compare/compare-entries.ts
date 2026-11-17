/**
 * Row 57-06 — the compare pages' facts (`/compare/<slug>`, Arabic at `/ar/compare/<slug>`).
 *
 * Repo content, written in English and Arabic side by side like the Help centre. Every competitor
 * cell was checked on that competitor's own website on {@link COMPARE_CHECKED_ON}; the source of
 * each one is kept beside it (`source`). A fact that could not be confirmed there is left out of
 * the table rather than guessed, and no competitor price is ever shown: the price row links the
 * competitor's own pricing page. The TManage column ({@link OURS}) says only what the product does
 * today. Arabic is Modern Standard Arabic; product names stay in Latin script, and an Arabic
 * string that starts with a Latin word starts with U+200F so it still reads right to left.
 * Figma: 604:33897 (desktop 608:34272 / 608:34464, mobile 608:34616 / 608:34708).
 */

import { HELLO_EMAIL } from '../../lib/public-contact';

export type CompareLanguage = 'en' | 'ar';

export type Bilingual = Readonly<Record<CompareLanguage, string>>;

/** The table's rows, in display order. `price` is always last and never names a price. */
export type CompareFeature = 'tasks' | 'clients' | 'time' | 'invoices' | 'arabic' | 'files';

/** `yes` renders a check, `no` a dash, `note` the text alone. */
export type CompareTone = 'yes' | 'no' | 'note';

export interface CompareCell {
  readonly tone: CompareTone;
  readonly text: Bilingual;
  /** The competitor page the fact was read on. */
  readonly source: string;
}

export interface CompareEntry {
  readonly slug: string;
  /** The product name, in Latin script in both languages. */
  readonly name: string;
  readonly pricingUrl: string;
  /** ISO date (YYYY-MM-DD) the facts were last checked. */
  readonly checkedOn: string;
  /** Three reasons this product may suit a reader. */
  readonly suits: Readonly<Record<CompareLanguage, readonly [string, string, string]>>;
  readonly strong: Bilingual;
  /** Only the rows confirmed on the competitor's site. */
  readonly rows: Readonly<Partial<Record<CompareFeature, CompareCell>>>;
}

/** U+200F RIGHT-TO-LEFT MARK. */
export const RLM = '‏';

/** The date every entry below was checked. */
export const COMPARE_CHECKED_ON = '2026-11-15';

/** Facts older than this many days show a "may be out of date" notice. */
export const COMPARE_STALE_AFTER_DAYS = 90;

/** The address readers write to when a fact has changed. */
export const COMPARE_CORRECTIONS_EMAIL = HELLO_EMAIL;

export const COMPARE_FEATURES: readonly CompareFeature[] = [
  'tasks',
  'clients',
  'time',
  'invoices',
  'arabic',
  'files',
];

/** The TManage column: true of the product today (approvals 52-19, time, finance, portal, Drive). */
export const OURS: Readonly<Record<CompareFeature | 'price', Bilingual>> = {
  tasks: { en: 'Yes', ar: 'نعم' },
  clients: { en: 'Yes, client users are always free', ar: 'نعم، ومستخدمو العملاء مجانيون دائمًا' },
  time: { en: 'Yes, timer and timesheets', ar: 'نعم، مؤقّت وجداول زمنية' },
  invoices: { en: 'Yes, invoices and retainers', ar: 'نعم، فواتير وعقود شهرية' },
  arabic: { en: 'Yes', ar: 'نعم' },
  files: {
    en: 'Your own Google Drive or OneDrive',
    ar: `في Google Drive أو OneDrive${RLM} الخاص بك`,
  },
  price: { en: 'Free during the beta', ar: 'مجاني خلال الفترة التجريبية' },
};

const yes = (en: string, ar: string, source: string): CompareCell => ({
  tone: 'yes',
  text: { en, ar },
  source,
});
const note = (en: string, ar: string, source: string): CompareCell => ({
  tone: 'note',
  text: { en, ar },
  source,
});

const BASECAMP = 'https://basecamp.com/features';
const MONDAY = 'https://monday.com/pricing';
const CLICKUP_FAQ = 'https://clickup.com/faqs';
const ASANA = 'https://asana.com/pricing';
const TEAMWORK = 'https://www.teamwork.com/pricing/';
const ZOHO = 'https://www.zoho.com/projects/zohoprojects-pricing.html';
const NOTION = 'https://www.notion.com/pricing';
const TEAMS = 'https://learn.microsoft.com/en-us/microsoftteams/teams-overview';

export const COMPARE_ENTRIES: readonly CompareEntry[] = [
  {
    slug: 'basecamp',
    name: 'Basecamp',
    pricingUrl: 'https://basecamp.com/pricing',
    checkedOn: COMPARE_CHECKED_ON,
    suits: {
      en: [
        'You want Hill Charts to show where work really stands',
        'You want client mode to choose what each client sees',
        'You want a tool built on 22 years of experience',
      ],
      ar: [
        `تريد مخططات Hill Charts${RLM} لتعرف أين وصل العمل فعلًا`,
        'تريد وضع العميل لتختار ما يراه كل عميل',
        'تريد أداة قائمة على خبرة 22 عامًا',
      ],
    },
    strong: {
      en: 'Basecamp keeps to-dos, docs, files and chat inside each project, lets you choose project by project what clients see, and shows progress with Hill Charts.',
      ar: `يجمع Basecamp${RLM} قوائم المهام والمستندات والملفات والمحادثات داخل كل مشروع، ويتيح لك أن تختار في كل مشروع ما يراه العملاء، ويعرض التقدّم بمخططات Hill Charts${RLM}.`,
    },
    rows: {
      tasks: yes('Yes, to-dos and subtasks', 'نعم، قوائم مهام ومهام فرعية', BASECAMP),
      clients: yes(
        'Yes, client mode chooses what clients see',
        'نعم، ووضع العميل يحدّد ما يراه العملاء',
        BASECAMP,
      ),
      time: yes('Yes, on some plans', 'نعم، في بعض الخطط', 'https://basecamp.com/pricing'),
      files: note(
        'Inside each project, with links to Google Docs, Dropbox and Figma',
        `داخل كل مشروع، مع روابط إلى Google Docs${RLM} و Dropbox${RLM} و Figma${RLM}`,
        BASECAMP,
      ),
    },
  },
  {
    slug: 'monday',
    name: 'monday.com',
    pricingUrl: 'https://monday.com/pricing',
    checkedOn: COMPARE_CHECKED_ON,
    suits: {
      en: [
        'You want no-code automations across your boards',
        'You want Gantt, workload and portfolio dashboards',
        'You rely on many integrations (850+ listed)',
      ],
      ar: [
        'تريد أتمتة بلا برمجة على لوحاتك',
        'تريد مخطط Gantt وعرض عبء العمل ولوحات المحافظ',
        'تعتمد على تكاملات كثيرة (أكثر من 850 تكاملًا معلنًا)',
      ],
    },
    strong: {
      en: 'monday work management offers no-code automations, Gantt and workload views, portfolio dashboards and more than 850 integrations.',
      ar: `يقدّم monday work management${RLM} أتمتة بلا برمجة، وعروض Gantt وعبء العمل، ولوحات للمحافظ، وأكثر من 850 تكاملًا.`,
    },
    rows: {
      tasks: yes(
        'Yes, with no-code automations',
        'نعم، مع أتمتة بلا برمجة',
        'https://monday.com/work-management',
      ),
      clients: yes(
        'Yes, guest access on the Standard plan',
        'نعم، دخول الضيوف في خطة Standard',
        MONDAY,
      ),
      time: yes('Yes, on the Pro plan', 'نعم، في خطة Pro', MONDAY),
      invoices: note(
        'In monday CRM, a separate product',
        `في monday CRM${RLM}، وهو منتج منفصل`,
        MONDAY,
      ),
    },
  },
  {
    slug: 'clickup',
    name: 'ClickUp',
    pricingUrl: 'https://clickup.com/pricing',
    checkedOn: COMPARE_CHECKED_ON,
    suits: {
      en: [
        'You want tasks, docs and chat in one workspace',
        'You want many views: List, Board, Gantt, Calendar and Whiteboards',
        'You want time tracking built in',
      ],
      ar: [
        'تريد المهام والمستندات والمحادثة في مساحة عمل واحدة',
        `تريد عروضًا كثيرة: القائمة واللوحة ومخطط Gantt${RLM} والتقويم والسبورات`,
        'تريد تتبّع الوقت مدمجًا في الأداة',
      ],
    },
    strong: {
      en: 'ClickUp puts tasks, docs, chat and AI in one workspace, with List, Board, Gantt, Calendar and Whiteboard views. Its AI can translate content into Arabic.',
      ar: `يجمع ClickUp${RLM} المهام والمستندات والمحادثة والذكاء الاصطناعي في مساحة عمل واحدة، مع عروض القائمة واللوحة ومخطط Gantt${RLM} والتقويم والسبورات. ويستطيع ذكاؤه الاصطناعي ترجمة المحتوى إلى العربية.`,
    },
    rows: {
      tasks: yes('Yes, with many views', 'نعم، مع عروض كثيرة', 'https://clickup.com/'),
      clients: yes('Yes, guests', 'نعم، ضيوف', 'https://clickup.com/pricing'),
      time: yes('Yes, built in', 'نعم، مدمج', CLICKUP_FAQ),
      arabic: {
        tone: 'no',
        text: { en: 'Not among its interface languages', ar: 'ليست ضمن لغات واجهته' },
        source: CLICKUP_FAQ,
      },
    },
  },
  {
    slug: 'asana',
    name: 'Asana',
    pricingUrl: 'https://asana.com/pricing',
    checkedOn: COMPARE_CHECKED_ON,
    suits: {
      en: [
        'You plan around goals and portfolios',
        'You want AI teammates working in the same plan',
        'You bring clients and contractors in as free guests',
      ],
      ar: [
        'تخطّط حول الأهداف والمحافظ',
        'تريد زملاء ذكاء اصطناعي يعملون في الخطة نفسها',
        'تضيف العملاء والمتعاقدين ضيوفًا مجانًا',
      ],
    },
    strong: {
      en: 'Asana connects goals, portfolios, projects and tasks, offers AI teammates and no-code automations, and lets clients and contractors join as free guests.',
      ar: `يربط Asana${RLM} الأهداف والمحافظ والمشاريع والمهام، ويقدّم زملاء ذكاء اصطناعي وأتمتة بلا برمجة، ويتيح للعملاء والمتعاقدين الانضمام ضيوفًا مجانًا.`,
    },
    rows: {
      tasks: yes(
        'Yes, with goals and portfolios',
        'نعم، مع الأهداف والمحافظ',
        'https://asana.com/',
      ),
      clients: yes(
        'Yes, unlimited free guests (Starter plan)',
        'نعم، ضيوف مجانيون بلا حد (خطة Starter)',
        ASANA,
      ),
      time: yes('Yes, on the Advanced plan', 'نعم، في خطة Advanced', ASANA),
    },
  },
  {
    slug: 'teamwork',
    name: 'Teamwork.com',
    pricingUrl: 'https://www.teamwork.com/pricing/',
    checkedOn: COMPARE_CHECKED_ON,
    suits: {
      en: [
        'You invoice clients from logged time',
        'You run time budgets and retainers',
        'You want to see the margin on every project',
      ],
      ar: [
        'تصدر فواتير العملاء من الوقت المسجَّل',
        'تدير ميزانيات الوقت والعقود الشهرية',
        'تريد أن ترى هامش الربح في كل مشروع',
      ],
    },
    strong: {
      en: 'Teamwork.com is built for agencies and consultancies: billable time, time budgets and retainers, client invoicing from logged time, and the margin on every project.',
      ar: `صُمّم Teamwork.com${RLM} للوكالات والاستشارات: وقت قابل للفوترة، وميزانيات وقت وعقود شهرية، وفواتير للعملاء من الوقت المسجَّل، وهامش الربح في كل مشروع.`,
    },
    rows: {
      tasks: yes('Yes, organised by client', 'نعم، منظّمة حسب العميل', TEAMWORK),
      time: yes(
        'Yes, billable time on paid plans',
        'نعم، وقت قابل للفوترة في الخطط المدفوعة',
        TEAMWORK,
      ),
      invoices: yes(
        'Yes, from logged time (Accelerate plan)',
        'نعم، من الوقت المسجَّل (خطة Accelerate)',
        TEAMWORK,
      ),
    },
  },
  {
    slug: 'zoho-projects',
    name: 'Zoho Projects',
    pricingUrl: 'https://www.zoho.com/projects/zohoprojects-pricing.html',
    checkedOn: COMPARE_CHECKED_ON,
    suits: {
      en: [
        'You already use other Zoho apps',
        'You want the interface in Arabic',
        'You want Gantt charts that show plan against progress',
      ],
      ar: [
        `تستخدم تطبيقات Zoho${RLM} أخرى بالفعل`,
        'تريد الواجهة باللغة العربية',
        'تريد مخططات Gantt تقارن الخطة بالتقدّم الفعلي',
      ],
    },
    strong: {
      en: 'Zoho Projects has offered Arabic with full right-to-left support since 2021, has Gantt charts that show plan against progress, and works with many other Zoho apps.',
      ar: `يدعم Zoho Projects${RLM} العربية مع اتجاه كامل من اليمين إلى اليسار منذ 2021، ويقدّم مخططات Gantt تقارن الخطة بالتقدّم، ويعمل مع كثير من تطبيقات Zoho${RLM} الأخرى.`,
    },
    rows: {
      tasks: yes(
        'Yes, with Gantt charts',
        'نعم، مع مخططات Gantt',
        'https://www.zoho.com/projects/',
      ),
      time: yes('Yes, on paid plans', 'نعم، في الخطط المدفوعة', ZOHO),
      invoices: note(
        'Through Zoho Invoice or Zoho Books',
        `عبر Zoho Invoice أو Zoho Books${RLM}`,
        ZOHO,
      ),
      arabic: yes(
        'Yes, right to left',
        'نعم، من اليمين إلى اليسار',
        'https://www.zoho.com/blog/projects/announcing-the-launch-of-arabic-support-in-zoho-projects.html',
      ),
    },
  },
  {
    slug: 'notion',
    name: 'Notion',
    pricingUrl: 'https://www.notion.com/pricing',
    checkedOn: COMPARE_CHECKED_ON,
    suits: {
      en: [
        'You want docs, a wiki and projects in one place',
        'You want the interface in Arabic',
        'You invite outside collaborators as free guests',
      ],
      ar: [
        'تريد المستندات وقاعدة المعرفة والمشاريع في مكان واحد',
        'تريد الواجهة باللغة العربية',
        'تدعو متعاونين من الخارج ضيوفًا مجانًا',
      ],
    },
    strong: {
      en: 'Notion brings docs, a wiki and projects into one system, with AI search and agents. Its interface is available in Arabic and mirrors in the desktop and mobile apps.',
      ar: `يجمع Notion${RLM} المستندات وقاعدة المعرفة والمشاريع في نظام واحد، مع بحث ووكلاء بالذكاء الاصطناعي. وواجهته متاحة بالعربية وتنعكس من اليمين إلى اليسار في تطبيقي سطح المكتب والجوال.`,
    },
    rows: {
      tasks: yes(
        'Yes, tasks, sub-tasks and dependencies',
        'نعم، مهام ومهام فرعية وتبعيات',
        'https://www.notion.com/product/projects',
      ),
      clients: yes('Yes, guests are free', 'نعم، والضيوف مجانيون', NOTION),
      arabic: yes(
        'Yes, mirrored in the desktop and mobile apps',
        'نعم، منعكسة في تطبيقي سطح المكتب والجوال',
        'https://www.notion.com/help/change-your-language',
      ),
    },
  },
  {
    slug: 'microsoft-teams',
    name: 'Microsoft Teams',
    pricingUrl:
      'https://www.microsoft.com/en-us/microsoft-teams/compare-microsoft-teams-business-options',
    checkedOn: COMPARE_CHECKED_ON,
    suits: {
      en: [
        'Your company already runs on Microsoft 365',
        'You want chat, meetings and shared documents in one hub',
        'You work with guests from outside your organisation',
      ],
      ar: [
        `تعمل شركتك على Microsoft 365${RLM} بالفعل`,
        'تريد المحادثة والاجتماعات والمستندات المشتركة في مكان واحد',
        'تعمل مع ضيوف من خارج مؤسستك',
      ],
    },
    strong: {
      en: 'Microsoft Teams is the hub for chat, meetings and co-authoring inside Microsoft 365. Each team gets its own SharePoint site for files, and guests from outside can join.',
      ar: `يُعدّ Microsoft Teams${RLM} مركز المحادثة والاجتماعات والتحرير المشترك داخل Microsoft 365${RLM}. يحصل كل فريق على موقع SharePoint${RLM} خاص لملفاته، ويمكن لضيوف من الخارج الانضمام.`,
    },
    rows: {
      tasks: note(
        'Through Planner, part of Microsoft 365',
        `عبر Planner${RLM}، ضمن Microsoft 365${RLM}`,
        TEAMS,
      ),
      clients: yes(
        'Yes, guest access',
        'نعم، دخول الضيوف',
        'https://learn.microsoft.com/en-us/microsoftteams/guest-access',
      ),
      files: note('In a SharePoint site for each team', `في موقع SharePoint${RLM} لكل فريق`, TEAMS),
    },
  },
];

export function findCompareEntry(slug: string): CompareEntry | undefined {
  return COMPARE_ENTRIES.find((entry) => entry.slug === slug);
}

/** `/compare`, `/compare/<slug>`, or their Arabic twins under `/ar`. */
export function compareHref(slug: string | undefined, language: CompareLanguage): string {
  const path = slug === undefined ? '/compare' : `/compare/${slug}`;
  return language === 'ar' ? `/ar${path}` : path;
}

/** True when `checkedOn` is more than {@link COMPARE_STALE_AFTER_DAYS} days before `now`. */
export function isCompareStale(checkedOn: string, now: Date): boolean {
  const ageMs = now.getTime() - Date.parse(`${checkedOn}T00:00:00Z`);
  return ageMs > COMPARE_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}
