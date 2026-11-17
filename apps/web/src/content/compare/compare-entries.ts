/**
 * Row 57-06 — the compare pages' facts (`/compare/<slug>`, Arabic at `/ar/compare/<slug>`).
 *
 * Repo content, written in English and Arabic side by side like the Help centre. Every competitor
 * cell was checked on that competitor's own website on the entry's `checkedOn` date; the source of
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

/** The date the first eight entries below were checked. */
export const COMPARE_CHECKED_ON = '2026-11-15';

/** SEO B3 — the date the twelve entries added after them were checked. */
const CHECKED_2026_11_17 = '2026-11-17';

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
const TRELLO = 'https://trello.com/pricing';
const JIRA = 'https://www.atlassian.com/software/jira/features';
const SLACK = 'https://slack.com/pricing';
const WRIKE = 'https://www.wrike.com/price/';
const PRODUCTIVE = 'https://www.productive.io/pricing/';
const SCORO = 'https://www.scoro.com/features/';
const ACCELO = 'https://www.accelo.com/features';
const BONSAI = 'https://www.hellobonsai.com/pricing';
const PLUTIO = 'https://www.plutio.com/pricing';
const SUITEDASH = 'https://www.suitedash.com/pricing/';
const MOXO = 'https://www.moxo.com/pricing';
const ASSEMBLY = 'https://assembly.com/';

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
  {
    slug: 'trello',
    name: 'Trello',
    pricingUrl: 'https://trello.com/pricing',
    checkedOn: CHECKED_2026_11_17,
    suits: {
      en: [
        'You want simple boards and cards your whole team understands',
        'You want no-code automation built into every board',
        'You connect boards to other apps with Power-Ups (200+ listed)',
      ],
      ar: [
        'تريد لوحات وبطاقات بسيطة يفهمها فريقك كله',
        'تريد أتمتة بلا برمجة مدمجة في كل لوحة',
        `تربط لوحاتك بتطبيقات أخرى عبر Power-Ups${RLM} (أكثر من 200 تطبيق معلن)`,
      ],
    },
    strong: {
      en: 'Trello keeps work on simple boards and cards, builds no-code automation into every board, and adds Calendar, Timeline, Table and Dashboard views on the Premium plan.',
      ar: `يعرض Trello${RLM} العمل على لوحات وبطاقات بسيطة، ويدمج أتمتة بلا برمجة في كل لوحة، ويضيف عروض التقويم والخط الزمني والجدول ولوحة المعلومات في خطة Premium${RLM}.`,
    },
    rows: {
      tasks: yes('Yes, boards and cards', 'نعم، لوحات وبطاقات', TRELLO),
      clients: yes(
        'Yes, board guests; a guest on more than one board is billed as a member',
        'نعم، ضيوف على اللوحات، والضيف على أكثر من لوحة يُحتسب عضوًا مدفوعًا',
        TRELLO,
      ),
      files: note(
        'Attached to cards, up to 10 MB a file on Free and 250 MB on Standard',
        'مرفقة بالبطاقات، حتى 10 ميغابايت للملف في الخطة المجانية و250 ميغابايت في Standard',
        TRELLO,
      ),
    },
  },
  {
    slug: 'jira',
    name: 'Jira',
    pricingUrl: 'https://www.atlassian.com/software/jira/pricing',
    checkedOn: CHECKED_2026_11_17,
    suits: {
      en: [
        'You want boards, lists, timelines and calendars over the same work',
        'You want burndown, cycle time and capacity reports',
        'You rely on a large marketplace (3,000+ integrations listed)',
      ],
      ar: [
        'تريد اللوحات والقوائم والخطوط الزمنية والتقويم فوق العمل نفسه',
        'تريد تقارير الإنجاز التنازلي وزمن الدورة وسعة الفريق',
        'تعتمد على سوق تكاملات كبير (أكثر من 3000 تكامل معلن)',
      ],
    },
    strong: {
      en: 'Jira shows work as boards, lists, timelines or calendars, maps dependencies across teams, and reports burndown, cycle time and capacity. Its Rovo AI builds automations from plain instructions.',
      ar: `يعرض Jira${RLM} العمل لوحاتٍ أو قوائم أو خطوطًا زمنية أو تقويمًا، ويربط التبعيات بين الفرق، ويقدّم تقارير الإنجاز التنازلي وزمن الدورة والسعة. ويبني ذكاؤه الاصطناعي Rovo${RLM} الأتمتة من تعليمات بلغة عادية.`,
    },
    rows: {
      tasks: yes(
        'Yes, boards, lists, timelines and calendars',
        'نعم، لوحات وقوائم وخطوط زمنية وتقويم',
        JIRA,
      ),
      time: yes(
        'Yes, log work on each work item',
        'نعم، تسجيل الوقت على كل بند عمل',
        'https://support.atlassian.com/jira-software-cloud/docs/log-time-on-an-issue/',
      ),
    },
  },
  {
    slug: 'slack',
    name: 'Slack',
    pricingUrl: 'https://slack.com/pricing',
    checkedOn: CHECKED_2026_11_17,
    suits: {
      en: [
        'Your team lives in channels and direct messages',
        'You talk with outside partners in shared Slack Connect channels',
        'You want quick group huddles with notes and transcripts',
      ],
      ar: [
        'يعمل فريقك داخل القنوات والرسائل المباشرة',
        `تتحدّث مع شركاء من الخارج في قنوات Slack Connect${RLM} المشتركة`,
        'تريد اجتماعات صوتية سريعة مع ملاحظات ونصوص مكتوبة',
      ],
    },
    strong: {
      en: 'Slack is built for conversation: channels, group huddles with notes and transcripts, Slack Connect with up to 250 outside organisations, and lists and canvases that keep work beside the chat on paid plans.',
      ar: `صُمّم Slack${RLM} للمحادثة: قنوات، واجتماعات صوتية جماعية مع ملاحظات ونصوص، وSlack Connect${RLM} مع ما يصل إلى 250 مؤسسة خارجية، وقوائم ولوحات canvas${RLM} تبقي العمل بجانب المحادثة في الخطط المدفوعة.`,
    },
    rows: {
      tasks: note(
        'In Slack lists, on paid plans',
        `في قوائم Slack${RLM}، في الخطط المدفوعة`,
        SLACK,
      ),
      clients: yes(
        'Yes, Slack Connect on paid plans; one-to-one only on Free',
        `نعم، Slack Connect${RLM} في الخطط المدفوعة، ومحادثات فردية فقط في الخطة المجانية`,
        SLACK,
      ),
      files: note(
        'Inside Slack; Free keeps 90 days of history',
        `داخل Slack${RLM}، وتحتفظ الخطة المجانية بسجل 90 يومًا`,
        SLACK,
      ),
    },
  },
  {
    slug: 'wrike',
    name: 'Wrike',
    pricingUrl: 'https://www.wrike.com/price/',
    checkedOn: CHECKED_2026_11_17,
    suits: {
      en: [
        'You want interactive Gantt charts and shareable dashboards',
        'You track budgets and billable hours across portfolios',
        'You want capacity planning for a large team',
      ],
      ar: [
        `تريد مخططات Gantt${RLM} تفاعلية ولوحات معلومات قابلة للمشاركة`,
        'تتابع الميزانيات والساعات القابلة للفوترة عبر المحافظ',
        'تريد تخطيط السعة لفريق كبير',
      ],
    },
    strong: {
      en: 'Wrike offers board and table views on its Free plan and interactive Gantt charts from the Team plan. On Pinnacle it adds resource and capacity planning with time tracking, and budgets for projects, portfolios and clients.',
      ar: `يقدّم Wrike${RLM} عرضَي اللوحة والجدول في خطته المجانية، ومخططات Gantt${RLM} تفاعلية بدءًا من خطة Team${RLM}. وفي خطة Pinnacle${RLM} يضيف تخطيط الموارد والسعة مع تتبّع الوقت، وميزانيات للمشاريع والمحافظ والعملاء.`,
    },
    rows: {
      tasks: yes(
        'Yes, with Gantt charts from the Team plan',
        `نعم، مع مخططات Gantt${RLM} بدءًا من خطة Team`,
        WRIKE,
      ),
      clients: note(
        'Outside users need a paid seat; free viewers are allowed',
        'يحتاج المستخدم الخارجي إلى مقعد مدفوع، ويُسمح بمشاهدين مجانًا',
        WRIKE,
      ),
      time: yes('Yes, on the Pinnacle plan', 'نعم، في خطة Pinnacle', WRIKE),
    },
  },
  {
    slug: 'productive',
    name: 'Productive',
    pricingUrl: 'https://www.productive.io/pricing/',
    checkedOn: CHECKED_2026_11_17,
    suits: {
      en: [
        'You run an agency on budgets, rate cards and margins',
        'You plan people’s time with resource planning',
        'You want revenue forecasting and scenario planning',
      ],
      ar: [
        'تدير وكالتك بالميزانيات وجداول الأسعار وهوامش الربح',
        'تخطّط وقت فريقك بتخطيط الموارد',
        'تريد توقّع الإيرادات وتخطيط السيناريوهات',
      ],
    },
    strong: {
      en: 'Productive is built for agencies: time tracking, budgets and rate cards, resource planning, and client invoices sent from the same tool. Clients can be added free of charge to follow progress.',
      ar: `صُمّم Productive${RLM} للوكالات: تتبّع الوقت، والميزانيات وجداول الأسعار، وتخطيط الموارد، وفواتير العملاء تُرسل من الأداة نفسها. ويمكن إضافة العملاء مجانًا ليتابعوا التقدّم.`,
    },
    rows: {
      tasks: yes('Yes, task management', 'نعم، إدارة المهام', PRODUCTIVE),
      clients: yes('Yes, clients join free of charge', 'نعم، وينضم العملاء مجانًا', PRODUCTIVE),
      time: yes('Yes, on every plan', 'نعم، في كل الخطط', PRODUCTIVE),
      invoices: yes(
        'Yes, client invoices sent from Productive',
        'نعم، فواتير العملاء تُرسل من Productive',
        PRODUCTIVE,
      ),
    },
  },
  {
    slug: 'scoro',
    name: 'Scoro',
    pricingUrl: 'https://www.scoro.com/pricing/',
    checkedOn: CHECKED_2026_11_17,
    suits: {
      en: [
        'You want quotes, delivery and billing in one flow',
        'You compare quoted against actual on every job',
        'You want a CRM and sales pipeline in the same tool',
      ],
      ar: [
        'تريد عروض الأسعار والتنفيذ والفوترة في مسار واحد',
        'تقارن المُقدَّر بالفعلي في كل عمل',
        'تريد إدارة علاقات العملاء ومسار المبيعات في الأداة نفسها',
      ],
    },
    strong: {
      en: 'Scoro connects quotes with margin estimates, project delivery, time tracking and invoicing from logged hours, with quoted-against-actual and revenue forecasting reports on its End-to-end plan.',
      ar: `يربط Scoro${RLM} عروض الأسعار وتقدير الهامش بتنفيذ المشاريع وتتبّع الوقت والفوترة من الساعات المسجَّلة، مع تقارير المُقدَّر مقابل الفعلي وتوقّع الإيرادات في خطة End-to-end${RLM}.`,
    },
    rows: {
      tasks: yes('Yes, tasks and projects', 'نعم، مهام ومشاريع', SCORO),
      clients: note(
        'A client portal is a paid extra',
        'بوابة العملاء إضافة مدفوعة',
        'https://www.scoro.com/pricing/',
      ),
      time: yes('Yes, on every plan', 'نعم، في كل الخطط', 'https://www.scoro.com/pricing/'),
      invoices: yes('Yes, from logged hours', 'نعم، من الساعات المسجَّلة', SCORO),
    },
  },
  {
    slug: 'accelo',
    name: 'Accelo',
    pricingUrl: 'https://www.accelo.com/pricing',
    checkedOn: CHECKED_2026_11_17,
    suits: {
      en: [
        'You run fixed-fee projects and retainers side by side',
        'You want quotes, rate cards and budgets in one place',
        'You use Xero, QuickBooks Online or Sage Intacct',
      ],
      ar: [
        'تدير مشاريع بسعر ثابت وعقودًا شهرية جنبًا إلى جنب',
        'تريد عروض الأسعار وجداول الأسعار والميزانيات في مكان واحد',
        `تستخدم Xero${RLM} أو QuickBooks Online${RLM} أو Sage Intacct${RLM}`,
      ],
    },
    strong: {
      en: 'Accelo is built for professional services: retainer management, quotes and rate cards, time tracking that feeds invoicing, Gantt charts with dependencies, and links to Xero, QuickBooks Online and Sage Intacct.',
      ar: `صُمّم Accelo${RLM} للخدمات المهنية: إدارة العقود الشهرية، وعروض الأسعار وجداول الأسعار، وتتبّع وقت يغذّي الفوترة، ومخططات Gantt${RLM} مع التبعيات، وربط مع Xero${RLM} و QuickBooks Online${RLM} و Sage Intacct${RLM}.`,
    },
    rows: {
      tasks: yes(
        'Yes, with Gantt charts and dependencies',
        `نعم، مع مخططات Gantt${RLM} والتبعيات`,
        ACCELO,
      ),
      clients: note(
        'Client approvals and requests in a Client Workspace',
        'اعتمادات العملاء وطلباتهم في مساحة Client Workspace',
        ACCELO,
      ),
      time: yes('Yes, with automated timesheets', 'نعم، مع جداول زمنية آلية', ACCELO),
      invoices: yes(
        'Yes, from logged time, retainers too',
        'نعم، من الوقت المسجَّل، والعقود الشهرية أيضًا',
        ACCELO,
      ),
    },
  },
  {
    slug: 'bonsai',
    name: 'Bonsai',
    pricingUrl: 'https://www.hellobonsai.com/pricing',
    checkedOn: CHECKED_2026_11_17,
    suits: {
      en: [
        'You want proposals, contracts and invoices next to the work',
        'You track income and expenses in the same tool',
        'You connect QuickBooks or Xero',
      ],
      ar: [
        'تريد العروض والعقود والفواتير بجانب العمل',
        'تتابع الدخل والمصروفات في الأداة نفسها',
        `تربط QuickBooks${RLM} أو Xero${RLM}`,
      ],
    },
    strong: {
      en: 'Bonsai covers the path from proposal to payment: proposals and contracts, a client portal, invoices with payments, time tracking with timesheets, and income and expense tracking from the Essentials plan.',
      ar: `يغطّي Bonsai${RLM} الطريق من العرض إلى الدفع: العروض والعقود، وبوابة للعملاء، وفواتير مع الدفع، وتتبّع الوقت مع الجداول الزمنية، وتتبّع الدخل والمصروفات بدءًا من خطة Essentials${RLM}.`,
    },
    rows: {
      tasks: yes(
        'Yes, with a Gantt view on Premium',
        `نعم، مع عرض Gantt${RLM} في خطة Premium`,
        BONSAI,
      ),
      clients: yes(
        'Yes, a client portal from the Essentials plan',
        'نعم، بوابة للعملاء بدءًا من خطة Essentials',
        BONSAI,
      ),
      time: yes('Yes, on every plan', 'نعم، في كل الخطط', BONSAI),
      invoices: yes(
        'Yes, with payments, from the Essentials plan',
        'نعم، مع الدفع، بدءًا من خطة Essentials',
        BONSAI,
      ),
      files: note('10 GB to 500 GB, by plan', 'من 10 إلى 500 غيغابايت حسب الخطة', BONSAI),
    },
  },
  {
    slug: 'plutio',
    name: 'Plutio',
    pricingUrl: 'https://www.plutio.com/pricing',
    checkedOn: CHECKED_2026_11_17,
    suits: {
      en: [
        'You are a freelancer or small agency that wants one app',
        'You send proposals and contracts for clients to sign',
        'You take payments through Stripe, PayPal or Square',
      ],
      ar: [
        'تعمل مستقلًا أو في وكالة صغيرة وتريد تطبيقًا واحدًا',
        'ترسل العروض والعقود ليوقّعها العملاء',
        `تستقبل المدفوعات عبر Stripe${RLM} أو PayPal${RLM} أو Square${RLM}`,
      ],
    },
    strong: {
      en: 'Plutio puts projects with Kanban, list, calendar and Gantt views, time tracking, proposals and contracts clients sign, and invoices paid through Stripe, PayPal or Square behind one client portal.',
      ar: `يجمع Plutio${RLM} خلف بوابة عملاء واحدة مشاريع بعروض Kanban${RLM} والقائمة والتقويم و Gantt${RLM}، وتتبّع الوقت، وعروضًا وعقودًا يوقّعها العملاء، وفواتير تُدفع عبر Stripe${RLM} أو PayPal${RLM} أو Square${RLM}.`,
    },
    rows: {
      tasks: yes(
        'Yes, Kanban, list, calendar and Gantt views',
        `نعم، عروض Kanban${RLM} والقائمة والتقويم و Gantt`,
        PLUTIO,
      ),
      clients: yes('Yes, a client portal on every plan', 'نعم، بوابة للعملاء في كل الخطط', PLUTIO),
      time: yes(
        'Yes, logged to projects and invoices',
        'نعم، يُسجَّل على المشاريع والفواتير',
        PLUTIO,
      ),
      invoices: yes(
        'Yes, paid through Stripe, PayPal or Square',
        `نعم، تُدفع عبر Stripe${RLM} أو PayPal${RLM} أو Square`,
        PLUTIO,
      ),
      files: note('100 GB to 2 TB, by plan', 'من 100 غيغابايت إلى 2 تيرابايت حسب الخطة', PLUTIO),
    },
  },
  {
    slug: 'suitedash',
    name: 'SuiteDash',
    pricingUrl: 'https://www.suitedash.com/pricing/',
    checkedOn: CHECKED_2026_11_17,
    suits: {
      en: [
        'You want unlimited white-label client portals',
        'You want one price for the whole account, not by seat',
        'You want a CRM with deal pipelines',
      ],
      ar: [
        'تريد بوابات عملاء بلا حد تحمل علامتك التجارية',
        'تريد سعرًا واحدًا للحساب كله لا حسب عدد المقاعد',
        'تريد إدارة علاقات العملاء مع مراحل الصفقات',
      ],
    },
    strong: {
      en: 'SuiteDash bundles white-label client portals, a CRM, projects and tasks, billing with subscriptions, proposals and file exchange, and charges one price for the whole account rather than by seat.',
      ar: `يجمع SuiteDash${RLM} بوابات عملاء تحمل علامتك التجارية، وإدارة علاقات العملاء، والمشاريع والمهام، والفوترة مع الاشتراكات، والعروض وتبادل الملفات، ويحتسب سعرًا واحدًا للحساب كله لا حسب عدد المقاعد.`,
    },
    rows: {
      tasks: yes('Yes, projects and tasks', 'نعم، مشاريع ومهام', SUITEDASH),
      clients: yes(
        'Yes, unlimited white-label portals',
        'نعم، بوابات بلا حد تحمل علامتك التجارية',
        SUITEDASH,
      ),
      invoices: yes('Yes, billing and subscriptions', 'نعم، فوترة واشتراكات', SUITEDASH),
      files: note(
        'File exchange, 100 GB to 2 TB by plan',
        'تبادل الملفات، من 100 غيغابايت إلى 2 تيرابايت حسب الخطة',
        SUITEDASH,
      ),
    },
  },
  {
    slug: 'moxo',
    name: 'Moxo',
    pricingUrl: 'https://www.moxo.com/pricing',
    checkedOn: CHECKED_2026_11_17,
    suits: {
      en: [
        'You run client processes in a regulated industry',
        'You want approvals, reviews and document collection as workflow steps',
        'Outside people act through a magic link, without an account',
      ],
      ar: [
        'تدير إجراءات العملاء في قطاع خاضع للتنظيم',
        'تريد الاعتمادات والمراجعات وجمع المستندات خطواتٍ في سير العمل',
        'يتصرّف الأشخاص من الخارج عبر رابط سحري دون حساب',
      ],
    },
    strong: {
      en: 'Moxo is built for client processes in regulated industries: a flow designer with 36 step types, approvals and reviews as steps, escalation when a due date passes, and branded portals outside people open with a magic link.',
      ar: `صُمّم Moxo${RLM} لإجراءات العملاء في القطاعات الخاضعة للتنظيم: مصمّم مسارات فيه 36 نوعًا من الخطوات، واعتمادات ومراجعات كخطوات، وتصعيد عند تجاوز الموعد، وبوابات تحمل علامتك يفتحها الأشخاص من الخارج برابط سحري.`,
    },
    rows: {
      tasks: note('Workflow steps with due dates', 'خطوات سير عمل لها مواعيد استحقاق', MOXO),
      clients: yes(
        'Yes, branded portals with no account needed',
        'نعم، بوابات تحمل علامتك ولا تحتاج إلى حساب',
        MOXO,
      ),
    },
  },
  {
    slug: 'assembly',
    name: 'Assembly',
    pricingUrl: 'https://assembly.com/pricing',
    checkedOn: CHECKED_2026_11_17,
    suits: {
      en: [
        'You want a branded portal where clients message, share files and pay',
        'You want to start on a free plan',
        'You add ready-made apps for intake and onboarding',
      ],
      ar: [
        'تريد بوابة تحمل علامتك يراسل فيها العملاء ويشاركون الملفات ويدفعون',
        'تريد أن تبدأ بخطة مجانية',
        'تضيف تطبيقات جاهزة لاستقبال العملاء وتهيئتهم',
      ],
    },
    strong: {
      en: 'Assembly gives each client a branded portal to message your team, share files, sign contracts, pay invoices and see the stage of their project, with ready-made intake and onboarding apps.',
      ar: `يمنح Assembly${RLM} كل عميل بوابة تحمل علامتك ليراسل فريقك ويشارك الملفات ويوقّع العقود ويدفع الفواتير ويرى مرحلة مشروعه، مع تطبيقات جاهزة لاستقبال العملاء وتهيئتهم.`,
    },
    rows: {
      tasks: note('A project tracker clients can see', 'متتبّع مشاريع يراه العملاء', ASSEMBLY),
      clients: yes(
        'Yes, a branded client portal',
        'نعم، بوابة عملاء تحمل علامتك',
        'https://assembly.com/pricing',
      ),
      invoices: yes(
        'Yes, billing and payments on every plan',
        'نعم، فوترة ومدفوعات في كل الخطط',
        'https://assembly.com/pricing',
      ),
      files: note('Shared with clients in the portal', 'تُشارك مع العملاء في البوابة', ASSEMBLY),
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
