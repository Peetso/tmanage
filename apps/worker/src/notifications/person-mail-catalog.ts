import type { Capability } from '@tmanage/domain';
import type { MailPersonTopic } from '@tmanage/mail';

/**
 * EMAILBUILD2 — every human-style mail TManage starts with a team member (amendment 2, "third
 * correction"): one general catalog, five topics (the lanes), and one entry per kind. A new kind
 * is one entry here plus its copy, with no new plumbing.
 *
 * ## How an entry is read
 *
 * - `topic` picks the TManage person who signs it (the same person per user and topic, 0371).
 * - `audience` and `capability` say who may receive it: a team member whose role holds the
 *   capability the screen asks for (the same check the screen uses). Clients and portal users are
 *   never candidates (the sweep reads `memberships` only).
 * - `when` is the condition, answered from facts the sweep reads with indexed lookups once per run
 *   (`PersonMailFacts`). A kind whose condition has no cheap indexed test is kept with its copy and
 *   `enabled: false`, and `disabledReason` says why (the report lists them).
 * - `cap` is the spacing class: `normal` (one person mail per 3 days in the workspace's first 14
 *   days, then per 7 days), `news` (outside that cap, at most one a day) or `outside` (only the
 *   after-new-device follow-up: outside the cap and the tips preference).
 * - `copy` is the EN and AR text. `{workspaceName}` and `{count}` are filled at send time; the
 *   greeting and the person's signature are added by the frame (`person-mail.ts`).
 *
 * Wording rules (amendment 1): the person offers help and asks for a reply, never claims to have
 * looked at the account by hand, uses no fake urgency, has one button, and never carries a code or
 * a sign-in link. Arabic is written from the meaning, in plain Modern Standard Arabic; brand names
 * stay in Latin letters.
 */

export type PersonMailAudience = 'member' | 'owner_admin' | 'owner';
export type PersonMailCap = 'normal' | 'news' | 'outside';

/** One language's text of a kind. `lines` are the paragraphs between greeting and button. */
export interface PersonMailCopy {
  readonly subject: string;
  readonly lines: readonly string[];
  readonly button: string;
  /** The closing line under the button (the reply invitation). */
  readonly close: string;
}

/** The facts one decision reads; built by the sweep from indexed lookups (see the store). */
export interface PersonMailFacts {
  readonly now: Date;
  readonly workspaceCreatedAt: Date;
  readonly joinedAt: Date;
  readonly activeMembers: number;
  readonly openTeamInvitations: number;
  /** Team invitations this user sent that are still open after 3 days. */
  readonly ownStaleInvitations: number;
  /** Workspace features with at least one row (`WORKSPACE_PROBES`). */
  readonly workspaceUsed: ReadonlySet<WorkspaceProbe>;
  /** Personal features this user has used (`PERSONAL_PROBES`). */
  readonly personalUsed: ReadonlySet<PersonalProbe>;
  /** At least 10 files in the workspace (an index range of 10 rows, never a count). */
  readonly tenFiles: boolean;
  readonly hasSignInPolicy: boolean;
  /** Newest session of any active member; null when none is kept. */
  readonly workspaceLastSignInAt: Date | null;
  /** Newest session of this user; null when none is kept. */
  readonly userLastSignInAt: Date | null;
  /** Newest "new device signed in" security notice of this user. */
  readonly newDeviceNoticeAt: Date | null;
  readonly profileTimezoneSet: boolean;
}

const DAY = 86_400_000;
const days = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / DAY;
const workspaceAge = (f: PersonMailFacts): number => days(f.workspaceCreatedAt, f.now);
const memberAge = (f: PersonMailFacts): number => days(f.joinedAt, f.now);

/**
 * Workspace "used?" probes: one `EXISTS`-style index probe each on the table's leading
 * `organization_id` index, all in one statement per workspace per run. Table names are fixed here,
 * never input.
 */
export const WORKSPACE_PROBES = {
  projects: 'projects',
  work_items: 'work_items',
  client_portal: 'client_memberships',
  files: 'file_assets',
  approvals: 'approvals',
  storage: 'storage_connections',
  time_tracking: 'work_item_time_logs',
  meetings: 'meetings',
  documents: 'documents',
  decisions: 'decisions',
  client_requests: 'client_requests',
  automations: 'workflow_templates',
  automation_schedules: 'automation_schedules',
  doc_templates: 'document_templates',
  report_schedules: 'insight_report_schedules',
  custom_reports: 'insight_custom_reports',
  glossary: 'glossary_terms',
  doc_collections: 'doc_collections',
  meeting_actions: 'meeting_action_items',
  custom_roles: 'custom_roles',
  checklist_templates: 'work_checklist_templates',
  work_labels: 'work_item_labels',
  snapshots: 'insight_snapshots',
  metric_alerts: 'insight_metric_alerts',
  objectives: 'org_objectives',
  meeting_series: 'meeting_series',
  webhooks: 'webhook_endpoints',
  announcements: 'org_announcements',
  teams: 'member_teams',
  invoices: 'client_invoices',
  quotes: 'quotes',
  expenses: 'expenses',
  retainers: 'retainers',
  timesheets: 'timesheets',
  forms: 'work_forms',
  inbound_mail: 'inbound_email_addresses',
} as const;
export type WorkspaceProbe = keyof typeof WORKSPACE_PROBES;

/** Personal probes: the table and the column that names the person (user or membership). */
export const PERSONAL_PROBES = {
  saved_searches: { table: 'saved_searches', by: 'user_id' },
  insight_views: { table: 'insight_saved_views', by: 'owner_user_id' },
  focus_blocks: { table: 'focus_blocks', by: 'membership_id' },
  doc_bookmarks: { table: 'doc_bookmarks', by: 'membership_id' },
  saved_messages: { table: 'message_bookmarks', by: 'membership_id' },
  inbox_filters: { table: 'inbox_saved_filters', by: 'membership_id' },
  calendar_connection: { table: 'calendar_connections', by: 'user_id' },
} as const;
export type PersonalProbe = keyof typeof PERSONAL_PROBES;

export interface PersonMailKind {
  /** The `mail_tip_log.tip_id` (ASCII, at most 40). */
  readonly id: string;
  readonly topic: MailPersonTopic;
  readonly audience: PersonMailAudience;
  readonly capability: Capability | null;
  readonly cap: PersonMailCap;
  /** Lower first: features closest to what a team already uses come first. */
  readonly priority: number;
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly when: (facts: PersonMailFacts) => boolean;
  /** Path under `/{orgSlug}`. */
  readonly link: string;
  readonly copy: { readonly en: PersonMailCopy; readonly ar: PersonMailCopy };
  /** `{count}` filler, when the copy names a number. */
  readonly count?: (facts: PersonMailFacts) => number;
}

// ---- features: every unused feature, one frame (amendment 2) --------------------------------

interface FeatureSpec {
  readonly id: string;
  readonly used:
    { readonly workspace: WorkspaceProbe } | { readonly personal: PersonalProbe } | null;
  readonly capability: Capability | null;
  readonly link: string;
  readonly priority: number;
  readonly name: { readonly en: string; readonly ar: string };
  /** The teaching empty-state sentence of the screen where one exists (already approved). */
  readonly benefit: { readonly en: string; readonly ar: string };
  readonly enabled?: false;
  readonly disabledReason?: string;
}

const FEATURES: readonly FeatureSpec[] = [
  {
    id: 'files',
    used: { workspace: 'files' },
    capability: 'file.upload',
    link: '/files',
    priority: 10,
    name: { en: 'Files', ar: 'الملفات' },
    benefit: {
      en: 'Keep every file of a project next to its tasks, with each new version kept and comments on the file itself.',
      ar: 'احتفظ بكل ملفات المشروع بجانب مهامه، مع حفظ كل نسخة جديدة والتعليقات على الملف نفسه.',
    },
  },
  {
    id: 'approvals',
    used: { workspace: 'approvals' },
    capability: 'deliverable.create',
    link: '/files',
    priority: 12,
    name: { en: 'Approvals', ar: 'الاعتمادات' },
    benefit: {
      en: 'An approval request is tied to one exact version of the file, so everyone knows what was agreed.',
      ar: 'طلب الاعتماد مرتبط بنسخة محددة من الملف، فيعرف الجميع ما الذي تم الاتفاق عليه.',
    },
  },
  {
    id: 'time_tracking',
    used: { workspace: 'time_tracking' },
    capability: 'work.update',
    link: '/work',
    priority: 14,
    name: { en: 'Time tracking', ar: 'تتبّع الوقت' },
    benefit: {
      en: 'A timer on a task shows how long the work really takes, which helps with the next quote.',
      ar: 'المؤقّت على المهمة يوضح كم يأخذ الشغل فعلًا، وهذا يفيدك في عرض السعر القادم.',
    },
  },
  {
    id: 'storage',
    used: { workspace: 'storage' },
    capability: 'storage.manage',
    link: '/admin/storage',
    priority: 16,
    name: { en: 'Drive or OneDrive storage', ar: 'التخزين على Drive أو OneDrive' },
    benefit: {
      en: 'When you connect one, the files you upload are kept in your own account, and you stay in control of them.',
      ar: 'عند الربط تُحفظ الملفات التي ترفعها في حسابك أنت، وتبقى تحت تحكمك.',
    },
  },
  {
    id: 'documents',
    used: { workspace: 'documents' },
    capability: 'doc.write',
    link: '/docs',
    priority: 18,
    name: { en: 'Docs', ar: 'المستندات' },
    benefit: {
      en: 'Write briefs and notes next to the work they belong to, and share them with your team.',
      ar: 'اكتب الملخصات والملاحظات بجانب العمل الذي تخصّه، وشاركها مع فريقك.',
    },
  },
  {
    id: 'meetings',
    used: { workspace: 'meetings' },
    capability: 'meeting.write',
    link: '/calendar/new',
    priority: 20,
    name: { en: 'Meetings', ar: 'الاجتماعات' },
    benefit: {
      en: 'Plan a meeting with its agenda and notes in the same place as the project.',
      ar: 'خطّط لاجتماع مع جدول أعماله وملاحظاته في المكان نفسه مع المشروع.',
    },
  },
  {
    id: 'client_requests',
    used: { workspace: 'client_requests' },
    capability: 'client_request.triage',
    link: '/work/requests',
    priority: 22,
    name: { en: 'Client requests', ar: 'طلبات العملاء' },
    benefit: {
      en: 'When clients ask for something in their portal, the request lands here for your team to pick up.',
      ar: 'عندما يطلب العملاء شيئًا من بوابتهم، يصل الطلب إلى هنا ليتولّاه فريقك.',
    },
  },
  {
    id: 'decisions',
    used: { workspace: 'decisions' },
    capability: 'decision.write',
    link: '/decisions',
    priority: 24,
    name: { en: 'Decisions', ar: 'القرارات' },
    benefit: {
      en: 'Write down what was decided and why, so nobody has to dig through chat later.',
      ar: 'دوّن ما تقرّر ولماذا، حتى لا يضطر أحد إلى البحث في المحادثات لاحقًا.',
    },
  },
  {
    id: 'quotes',
    used: { workspace: 'quotes' },
    capability: 'finance.manage',
    link: '/quotes',
    priority: 26,
    name: { en: 'Quotes', ar: 'عروض الأسعار' },
    benefit: {
      en: 'Send a quote your client can accept in the portal, and turn it into a project when they do.',
      ar: 'أرسل عرض سعر يقبله عميلك من البوابة، وحوّله إلى مشروع عند قبوله.',
    },
  },
  {
    id: 'invoices',
    used: { workspace: 'invoices' },
    capability: 'finance.manage',
    link: '/finance/invoices',
    priority: 28,
    name: { en: 'Client invoices', ar: 'فواتير العملاء' },
    benefit: {
      en: 'Send an invoice from the work you did, and your client opens it in their portal.',
      ar: 'أرسل فاتورة من العمل الذي أنجزته، ويفتحها عميلك من بوابته.',
    },
  },
  {
    id: 'automations',
    used: { workspace: 'automations' },
    capability: 'org.manage',
    link: '/automations',
    priority: 30,
    name: { en: 'Automations', ar: 'الأتمتة' },
    benefit: {
      en: 'Automations do the routine steps for you, like assigning a task or telling a client when something changes.',
      ar: 'تتولّى الأتمتة الخطوات المتكررة عنك، مثل إسناد مهمة أو إبلاغ العميل عندما يتغيّر شيء.',
    },
  },
  {
    id: 'calendar_connection',
    used: { personal: 'calendar_connection' },
    capability: null,
    link: '/settings/calendar-connections',
    priority: 32,
    name: { en: 'Calendar connection', ar: 'ربط التقويم' },
    benefit: {
      en: 'Connect your Google or Outlook calendar, and your TManage meetings and due dates show up there.',
      ar: 'اربط تقويم Google أو Outlook، وستظهر اجتماعاتك ومواعيد التسليم من TManage فيه.',
    },
  },
  {
    id: 'doc_templates',
    used: { workspace: 'doc_templates' },
    capability: 'doc.write',
    link: '/docs/templates',
    priority: 34,
    name: { en: 'Document templates', ar: 'قوالب المستندات' },
    benefit: {
      en: 'Templates let your team start briefs, reports and other documents from a ready layout.',
      ar: 'تتيح القوالب لفريقك بدء الملخصات والتقارير وغيرها من المستندات من تنسيق جاهز.',
    },
  },
  {
    id: 'checklist_templates',
    used: { workspace: 'checklist_templates' },
    capability: 'work.update',
    link: '/work',
    priority: 36,
    name: { en: 'Checklist templates', ar: 'قوالب قوائم التحقق' },
    benefit: {
      en: 'Turn steps you repeat on every task into a checklist you can add in one go.',
      ar: 'حوّل الخطوات التي تكرّرها في كل مهمة إلى قائمة تحقق تضيفها دفعة واحدة.',
    },
  },
  {
    id: 'work_labels',
    used: { workspace: 'work_labels' },
    capability: 'work.update',
    link: '/work',
    priority: 38,
    name: { en: 'Task labels', ar: 'تصنيفات المهام' },
    benefit: {
      en: 'Labels sort tasks at a glance, like Urgent, Design or Waiting on client.',
      ar: 'تساعدك التصنيفات على فرز المهام بنظرة واحدة، مثل «عاجل» أو «تصميم» أو «بانتظار العميل».',
    },
  },
  {
    id: 'meeting_series',
    used: { workspace: 'meeting_series' },
    capability: 'meeting.write',
    link: '/calendar/series',
    priority: 40,
    name: { en: 'Repeating meetings', ar: 'الاجتماعات المتكررة' },
    benefit: {
      en: 'Plan a meeting that repeats, like a weekly check-in, once instead of every time.',
      ar: 'خطّط مرة واحدة لاجتماع يتكرّر، مثل المتابعة الأسبوعية، بدلًا من تكرار ذلك كل مرة.',
    },
  },
  {
    id: 'meeting_actions',
    used: { workspace: 'meeting_actions' },
    capability: 'meeting.write',
    link: '/calendar',
    priority: 42,
    name: { en: 'Meeting action items', ar: 'مهام ما بعد الاجتماع' },
    benefit: {
      en: 'Write down who does what after a meeting, so nothing agreed gets lost.',
      ar: 'دوّن من سيفعل ماذا بعد الاجتماع، حتى لا يضيع شيء مما اتُّفق عليه.',
    },
  },
  {
    id: 'focus_blocks',
    used: { personal: 'focus_blocks' },
    capability: 'meeting.read',
    link: '/calendar/focus-blocks',
    priority: 44,
    name: { en: 'Focus time', ar: 'وقت التركيز' },
    benefit: {
      en: 'Block quiet time in your calendar for deep work, so meetings do not fill the whole day.',
      ar: 'احجز وقتًا هادئًا في تقويمك للعمل المركّز، حتى لا تملأ الاجتماعات يومك كله.',
    },
  },
  {
    id: 'teams',
    used: { workspace: 'teams' },
    capability: 'people.edit',
    link: '/people/teams',
    priority: 46,
    name: { en: 'Teams', ar: 'الفرق' },
    benefit: {
      en: 'Group people who work together, like Design or Sales, so you can assign and plan by team.',
      ar: 'اجمع الأشخاص الذين يعملون معًا، مثل التصميم أو المبيعات، لتوزّع المهام وتخطّط حسب الفريق.',
    },
  },
  {
    id: 'objectives',
    used: { workspace: 'objectives' },
    capability: 'project.manage',
    link: '/objectives',
    priority: 48,
    name: { en: 'Objectives', ar: 'الأهداف' },
    benefit: {
      en: 'Set the few goals that matter this quarter, and link the work that moves them.',
      ar: 'حدّد الأهداف القليلة المهمة لهذا الربع، واربط بها العمل الذي يحقّقها.',
    },
  },
  {
    id: 'custom_reports',
    used: { workspace: 'custom_reports' },
    capability: 'report.view',
    link: '/insights/custom-reports',
    priority: 50,
    name: { en: 'Custom reports', ar: 'التقارير المخصصة' },
    benefit: {
      en: 'Build the report you need once, then open it whenever you want fresh numbers.',
      ar: 'جهّز التقرير الذي تحتاجه مرة واحدة، ثم افتحه متى أردت أرقامًا محدّثة.',
    },
  },
  {
    id: 'report_schedules',
    used: { workspace: 'report_schedules' },
    capability: 'report.view',
    link: '/insights/report-schedules',
    priority: 52,
    name: { en: 'Report schedules', ar: 'جدولة التقارير' },
    benefit: {
      en: 'Send a report to the right people on a regular rhythm, without building it each time.',
      ar: 'أرسل التقرير إلى الأشخاص المعنيين بانتظام، دون أن تعيد إعداده كل مرة.',
    },
  },
  {
    id: 'insight_views',
    used: { personal: 'insight_views' },
    capability: 'report.view',
    link: '/insights/saved-views',
    priority: 54,
    name: { en: 'Saved report views', ar: 'طرق عرض التقارير المحفوظة' },
    benefit: {
      en: 'Save a report with the filters you like, so you can open the same view again in one click.',
      ar: 'احفظ التقرير بعوامل التصفية التي تفضّلها، لتفتح العرض نفسه مجددًا بنقرة واحدة.',
    },
  },
  {
    id: 'snapshots',
    used: { workspace: 'snapshots' },
    capability: 'report.view',
    link: '/insights',
    priority: 56,
    name: { en: 'Report snapshots', ar: 'لقطات التقارير' },
    benefit: {
      en: "A snapshot keeps today's numbers, so you can compare them with next month.",
      ar: 'تحتفظ اللقطة بأرقام اليوم، لتقارنها بأرقام الشهر القادم.',
    },
  },
  {
    id: 'metric_alerts',
    used: { workspace: 'metric_alerts' },
    capability: 'report.view',
    link: '/insights/metric-alerts',
    priority: 58,
    name: { en: 'Metric alerts', ar: 'تنبيهات الأرقام' },
    benefit: {
      en: 'An alert tells you when a number crosses the line you set, like hours over budget.',
      ar: 'ينبّهك التنبيه عندما يتجاوز رقمٌ الحدّ الذي وضعته، مثل ساعات تزيد على الميزانية.',
    },
  },
  {
    id: 'automation_schedules',
    used: { workspace: 'automation_schedules' },
    capability: 'org.manage',
    link: '/automations/schedules',
    priority: 60,
    name: { en: 'Automation schedules', ar: 'جداول الأتمتة' },
    benefit: {
      en: 'A schedule runs an automation at a set time, such as every Monday morning.',
      ar: 'الجدول الزمني يشغّل الأتمتة في وقت محدد، مثل صباح كل يوم إثنين.',
    },
  },
  {
    id: 'forms',
    used: { workspace: 'forms' },
    capability: 'work.create',
    link: '/forms',
    priority: 62,
    name: { en: 'Forms', ar: 'النماذج' },
    benefit: {
      en: 'Share a form, and every answer becomes a task your team can pick up.',
      ar: 'شارك نموذجًا، وكل إجابة تتحوّل إلى مهمة يتولّاها فريقك.',
    },
  },
  {
    id: 'inbound_mail',
    used: { workspace: 'inbound_mail' },
    capability: 'org.manage',
    link: '/settings/inbound-mail',
    priority: 64,
    name: { en: 'Request address', ar: 'عنوان الطلبات' },
    benefit: {
      en: 'Give clients one e-mail address, and what they send lands as a request for your team.',
      ar: 'امنح عملاءك عنوان بريد واحدًا، وما يرسلونه يصل طلبًا إلى فريقك.',
    },
  },
  {
    id: 'expenses',
    used: { workspace: 'expenses' },
    capability: 'finance.manage',
    link: '/finance/expenses',
    priority: 66,
    name: { en: 'Expenses', ar: 'المصروفات' },
    benefit: {
      en: 'Record what a project costs beyond time, so the numbers show the real profit.',
      ar: 'سجّل ما يكلّفه المشروع غير الوقت، لتُظهر الأرقام الربح الحقيقي.',
    },
  },
  {
    id: 'retainers',
    used: { workspace: 'retainers' },
    capability: 'finance.manage',
    link: '/finance/retainers',
    priority: 68,
    name: { en: 'Retainers', ar: 'الاتفاقات الشهرية' },
    benefit: {
      en: 'Keep a monthly client agreement in one place and see how much of it is used.',
      ar: 'احتفظ باتفاق العميل الشهري في مكان واحد، واعرف كم استُخدم منه.',
    },
  },
  {
    id: 'timesheets',
    used: { workspace: 'timesheets' },
    capability: 'time.view_team',
    link: '/finance/timesheets',
    priority: 70,
    name: { en: 'Timesheets', ar: 'سجلات الدوام' },
    benefit: {
      en: "Collect the week's hours from the team and approve them in one place.",
      ar: 'اجمع ساعات الأسبوع من الفريق واعتمدها في مكان واحد.',
    },
  },
  {
    id: 'doc_collections',
    used: { workspace: 'doc_collections' },
    capability: 'doc.write',
    link: '/docs/collections',
    priority: 72,
    name: { en: 'Document collections', ar: 'مجموعات المستندات' },
    benefit: {
      en: 'Group related documents, like an onboarding pack or a style guide, so they are easy to find.',
      ar: 'اجمع المستندات المترابطة، مثل حزمة تعريف الموظفين الجدد أو دليل الأسلوب، ليسهل العثور عليها.',
    },
  },
  {
    id: 'glossary',
    used: { workspace: 'glossary' },
    capability: 'doc.write',
    link: '/docs',
    priority: 74,
    name: { en: 'Glossary', ar: 'المسرد' },
    benefit: {
      en: 'Collect the words your team and clients use, so everyone means the same thing.',
      ar: 'اجمع المصطلحات التي يستخدمها فريقك وعملاؤك، ليقصد الجميع المعنى نفسه.',
    },
  },
  {
    id: 'doc_bookmarks',
    used: { personal: 'doc_bookmarks' },
    capability: 'doc.read',
    link: '/docs',
    priority: 76,
    name: { en: 'Document bookmarks', ar: 'الإشارات المرجعية للمستندات' },
    benefit: {
      en: 'Bookmark a document you open often, and it waits for you here.',
      ar: 'ضع إشارة مرجعية على مستند تفتحه كثيرًا، وستجده هنا بانتظارك.',
    },
  },
  {
    id: 'saved_messages',
    used: { personal: 'saved_messages' },
    capability: 'conversation.read',
    link: '/chat',
    priority: 78,
    name: { en: 'Saved messages', ar: 'الرسائل المحفوظة' },
    benefit: {
      en: 'Save a chat message you want to come back to, and it stays here for you.',
      ar: 'احفظ رسالة دردشة تريد الرجوع إليها، وستبقى هنا من أجلك.',
    },
  },
  {
    id: 'saved_searches',
    used: { personal: 'saved_searches' },
    capability: 'search.use',
    link: '/search/saved',
    priority: 80,
    name: { en: 'Saved searches', ar: 'عمليات البحث المحفوظة' },
    benefit: {
      en: 'Save a search you run often and open it again in one click.',
      ar: 'احفظ بحثًا تكرّره كثيرًا، وافتحه مجددًا بنقرة واحدة.',
    },
  },
  {
    id: 'inbox_filters',
    used: { personal: 'inbox_filters' },
    capability: null,
    link: '/inbox',
    priority: 82,
    name: { en: 'Inbox filters', ar: 'عوامل تصفية صندوق الوارد' },
    benefit: {
      en: 'Save the inbox view you use most, so the right messages are one click away.',
      ar: 'احفظ طريقة العرض التي تستخدمها أكثر في صندوق الوارد، لتصل إلى الرسائل المهمة بنقرة واحدة.',
    },
  },
  {
    id: 'custom_roles',
    used: { workspace: 'custom_roles' },
    capability: 'org.manage',
    link: '/admin/roles',
    priority: 84,
    name: { en: 'Custom roles', ar: 'الأدوار المخصصة' },
    benefit: {
      en: 'Make a role that fits how your company works, with exactly the rights it needs.',
      ar: 'أنشئ دورًا يناسب طريقة عمل شركتك، بالصلاحيات التي يحتاجها تمامًا.',
    },
  },
  {
    id: 'webhooks',
    used: { workspace: 'webhooks' },
    capability: 'org.manage',
    link: '/admin/automations/webhooks',
    priority: 86,
    name: { en: 'Webhooks', ar: 'الـWebhooks' },
    benefit: {
      en: 'A webhook tells another tool the moment something happens in TManage.',
      ar: 'يُبلغ الـWebhook أداةً أخرى فور حدوث شيء في TManage.',
    },
  },
  {
    id: 'announcements',
    used: { workspace: 'announcements' },
    capability: 'org.manage',
    link: '/admin',
    priority: 88,
    name: { en: 'Announcements', ar: 'الإعلانات' },
    benefit: {
      en: 'Share news with the whole company in a banner everyone sees when they sign in.',
      ar: 'شارك الأخبار مع الشركة كلها في شريط يراه الجميع عند تسجيل الدخول.',
    },
  },
  {
    id: 'esign',
    used: null,
    capability: 'deliverable.publish',
    link: '/signatures',
    priority: 90,
    name: { en: 'E-signatures', ar: 'التوقيع الإلكتروني' },
    benefit: {
      en: 'Ask a client to sign a document in their portal, with a short code to confirm it is them.',
      ar: 'اطلب من عميلك توقيع مستند من بوابته، مع رمز قصير لتأكيد هويته.',
    },
    enabled: false,
    disabledReason: 'public-claims.ts lists e_signature as hidden (not a live claim)',
  },
  {
    id: 'sso',
    used: null,
    capability: 'org.security.manage',
    link: '/admin/security',
    priority: 92,
    name: { en: 'Single sign-on', ar: 'تسجيل الدخول الموحّد' },
    benefit: {
      en: "Let your team sign in with your company's own account, and remove access in one place when someone leaves.",
      ar: 'اسمح لفريقك بتسجيل الدخول بحساب شركتك، وأوقف الوصول من مكان واحد عندما يغادر أحد.',
    },
    enabled: false,
    disabledReason:
      'sso_connections holds the identity-provider secrets; the worker is not granted a read on it',
  },
  {
    id: 'passkeys',
    used: null,
    capability: null,
    link: '/settings/sign-in-security',
    priority: 94,
    name: { en: 'Passkeys', ar: 'مفاتيح المرور' },
    benefit: {
      en: 'Sign in with your fingerprint, face or device PIN instead of a password that can be guessed.',
      ar: 'سجّل الدخول ببصمتك أو وجهك أو رمز جهازك بدلًا من كلمة مرور يمكن تخمينها.',
    },
    enabled: false,
    disabledReason: 'user_passkeys is a credential table; the worker is not granted a read on it',
  },
];

function featureKind(spec: FeatureSpec): PersonMailKind {
  const { used } = spec;
  return {
    id: `feature:${spec.id}`,
    topic: 'features',
    audience: 'member',
    capability: spec.capability,
    cap: 'normal',
    priority: spec.priority,
    enabled: spec.enabled !== false && used !== null,
    ...(spec.disabledReason === undefined ? {} : { disabledReason: spec.disabledReason }),
    // Only after the first week: a new team first hears the onboarding lane.
    when: (f) =>
      used !== null &&
      workspaceAge(f) >= 7 &&
      memberAge(f) >= 3 &&
      ('workspace' in used
        ? !f.workspaceUsed.has(used.workspace)
        : !f.personalUsed.has(used.personal)),
    link: spec.link,
    copy: {
      en: {
        subject: `Not tried yet: ${spec.name.en}`,
        lines: [
          spec.benefit.en,
          'You have not used it in {workspaceName} yet. It takes a few minutes to try.',
        ],
        button: `Open ${spec.name.en}`,
        close: 'If something about it is unclear, reply and I will explain.',
      },
      ar: {
        subject: `لم تجرّبه بعد: ${spec.name.ar}`,
        lines: [spec.benefit.ar, 'لم تستخدمه في {workspaceName} حتى الآن، وتجربته تأخذ دقائق.'],
        button: `افتح ${spec.name.ar}`,
        close: 'إذا كان فيه شيء غير واضح، ردّ عليّ وسأشرح لك.',
      },
    },
  };
}

// ---- better-use tips (features the user DOES use) ------------------------------------------

/** "A faster way to…" after 5+ uses. Needs a per-user use count: no cheap indexed test today. */
const BETTER_USE: readonly {
  readonly id: string;
  readonly link: string;
  readonly en: readonly [string, string];
  readonly ar: readonly [string, string];
}[] = [
  {
    id: 'tasks',
    link: '/work',
    en: [
      'A faster way to plan your week',
      'Saved views keep the filters you use for tasks, so your week opens the way you like it in one click.',
    ],
    ar: [
      'طريقة أسرع لتخطيط أسبوعك',
      'تحفظ طرق العرض عوامل التصفية التي تستخدمها للمهام، فيفتح أسبوعك كما تحب بنقرة واحدة.',
    ],
  },
  {
    id: 'files',
    link: '/files',
    en: [
      'A faster way to get feedback on a file',
      'Comment on the exact spot of a file instead of describing it in chat; everyone sees the note in place.',
    ],
    ar: [
      'طريقة أسرع للحصول على ملاحظات على ملف',
      'علّق على الموضع المحدد في الملف بدلًا من وصفه في المحادثة، ليرى الجميع الملاحظة في مكانها.',
    ],
  },
  {
    id: 'chat',
    link: '/chat',
    en: [
      'A faster way to turn chat into work',
      'Turn a chat message into a task in two clicks, so a request in a conversation is not forgotten.',
    ],
    ar: [
      'طريقة أسرع لتحويل المحادثة إلى عمل',
      'حوّل رسالة المحادثة إلى مهمة بنقرتين، حتى لا يُنسى طلب جاء في محادثة.',
    ],
  },
  {
    id: 'time',
    link: '/work',
    en: [
      'A faster way to log your hours',
      'Start the timer from the task itself; the time is filed under the right project without a separate entry.',
    ],
    ar: [
      'طريقة أسرع لتسجيل ساعاتك',
      'شغّل المؤقّت من المهمة نفسها، فيُسجَّل الوقت في المشروع الصحيح دون إدخال منفصل.',
    ],
  },
  {
    id: 'meetings',
    link: '/calendar',
    en: [
      'A faster way to follow up on a meeting',
      'Add action items during the meeting, and each one becomes a task with an owner when you save.',
    ],
    ar: [
      'طريقة أسرع لمتابعة الاجتماع',
      'أضف المهام أثناء الاجتماع، وتتحوّل كل واحدة إلى مهمة لها مسؤول عند الحفظ.',
    ],
  },
];

function betterUseKind(tip: (typeof BETTER_USE)[number], priority: number): PersonMailKind {
  return {
    id: `better:${tip.id}`,
    topic: 'features',
    audience: 'member',
    capability: null,
    cap: 'normal',
    priority,
    enabled: false,
    disabledReason: 'needs a per-user use count (5+ uses); no cheap indexed test today',
    when: () => false,
    link: tip.link,
    copy: {
      en: {
        subject: tip.en[0],
        lines: [tip.en[1]],
        button: 'Show me',
        close: 'If it does not fit how you work, reply and tell me.',
      },
      ar: {
        subject: tip.ar[0],
        lines: [tip.ar[1]],
        button: 'أرني',
        close: 'إذا لم يناسب طريقة شغلك، ردّ عليّ وأخبرني.',
      },
    },
  };
}

// ---- the hand-written kinds ------------------------------------------------------------------

const SECURITY_PROMISE_EN = 'I will never ask for your password or a code.';
const SECURITY_PROMISE_AR = 'لن أطلب منك كلمة المرور أو أي رمز أبدًا.';

const KINDS: readonly PersonMailKind[] = [
  // ---- onboarding ----
  {
    id: 'onboarding:day1_start',
    topic: 'onboarding',
    audience: 'member',
    capability: null,
    cap: 'normal',
    priority: 1,
    enabled: true,
    when: (f) => memberAge(f) >= 1 && memberAge(f) < 4,
    link: '/home',
    copy: {
      en: {
        subject: 'How to start in {workspaceName}',
        lines: [
          'Three first steps make TManage useful from day one: open your tasks, add a file to a project, and write to your team in its chat.',
          'Each takes a minute, and nothing you do can break anything.',
        ],
        button: 'Open {workspaceName}',
        close: 'Not sure where to begin? Reply and tell me what your work looks like.',
      },
      ar: {
        subject: 'كيف تبدأ في {workspaceName}',
        lines: [
          'ثلاث خطوات أولى تجعل TManage مفيدًا من اليوم الأول: افتح مهامك، وأضف ملفًا إلى مشروع، واكتب لفريقك في محادثته.',
          'كل خطوة تأخذ دقيقة، ولا شيء تفعله يمكن أن يفسد شيئًا.',
        ],
        button: 'افتح {workspaceName}',
        close: 'لا تعرف من أين تبدأ؟ ردّ عليّ واحكِ لي عن طبيعة شغلك.',
      },
    },
  },
  {
    id: 'onboarding:invite_team',
    topic: 'onboarding',
    audience: 'member',
    capability: 'people.invite',
    cap: 'normal',
    priority: 2,
    enabled: true,
    when: (f) => workspaceAge(f) >= 2 && f.activeMembers === 1 && f.openTeamInvitations === 0,
    link: '/people',
    copy: {
      en: {
        subject: 'Bring your team into {workspaceName}',
        lines: [
          "You're the only one in {workspaceName} so far. TManage gets useful when the people you work with can see the same tasks and files.",
          'Inviting someone takes about a minute, and you choose what each person can see.',
        ],
        button: 'Invite a teammate',
        close: 'Stuck on roles or permissions? Reply and tell me what you need.',
      },
      ar: {
        subject: 'ادعُ فريقك إلى {workspaceName}',
        lines: [
          'أنت الوحيد في {workspaceName} حتى الآن. TManage يفيدك أكثر عندما يرى زملاؤك المهام والملفات نفسها.',
          'دعوة أي شخص تأخذ دقيقة تقريبًا، وأنت من يحدد ما يراه كل واحد.',
        ],
        button: 'ادعُ زميلًا',
        close: 'محتار في الأدوار أو الصلاحيات؟ ردّ عليّ واكتب ما تحتاجه.',
      },
    },
  },
  {
    id: 'onboarding:first_project',
    topic: 'onboarding',
    audience: 'member',
    capability: 'project.create',
    cap: 'normal',
    priority: 3,
    enabled: true,
    when: (f) => workspaceAge(f) >= 3 && !f.workspaceUsed.has('projects'),
    link: '/projects/new',
    copy: {
      en: {
        subject: 'Your first project in {workspaceName}',
        lines: [
          '{workspaceName} has no project yet. A project keeps the tasks, files and client approvals for one piece of work in one place.',
          'Start with something real and small. You can change everything later.',
        ],
        button: 'Create a project',
        close: 'Not sure how to set it up for your kind of work? Reply and describe it.',
      },
      ar: {
        subject: 'أول مشروع لك في {workspaceName}',
        lines: [
          'لا يوجد مشروع في {workspaceName} بعد. المشروع يجمع المهام والملفات وموافقات العميل لعمل واحد في مكان واحد.',
          'ابدأ بعمل حقيقي وصغير، ويمكنك تعديل كل شيء لاحقًا.',
        ],
        button: 'أنشئ مشروعًا',
        close: 'لا تعرف كيف ترتبه بما يناسب شغلك؟ ردّ عليّ واشرح لي.',
      },
    },
  },
  {
    id: 'onboarding:invite_client',
    topic: 'onboarding',
    audience: 'member',
    capability: 'client_member.manage',
    cap: 'normal',
    priority: 4,
    enabled: true,
    when: (f) =>
      workspaceAge(f) >= 7 &&
      f.workspaceUsed.has('projects') &&
      !f.workspaceUsed.has('client_portal'),
    link: '/clients',
    copy: {
      en: {
        subject: 'Let your client see the work',
        lines: [
          'You have projects in {workspaceName}, but no client has been invited yet. In the client portal your client sees only what you share, comments on files and approves them, without creating a team account.',
        ],
        button: 'Invite a client',
        close: 'Want to know exactly what a client can and cannot see? Reply and ask.',
      },
      ar: {
        subject: 'دع عميلك يرى الشغل',
        lines: [
          'عندك مشاريع في {workspaceName} لكنك لم تدعُ أي عميل بعد. في بوابة العميل يرى عميلك ما تشاركه فقط، ويعلّق على الملفات ويعتمدها، دون أن ينشئ حسابًا في الفريق.',
        ],
        button: 'ادعُ عميلًا',
        close: 'تريد أن تعرف بالضبط ما يراه العميل وما لا يراه؟ ردّ عليّ واسأل.',
      },
    },
  },
  {
    id: 'onboarding:profile_unfinished',
    topic: 'onboarding',
    audience: 'member',
    capability: null,
    cap: 'normal',
    priority: 5,
    enabled: true,
    when: (f) => memberAge(f) >= 3 && !f.profileTimezoneSet,
    link: '/settings',
    copy: {
      en: {
        subject: 'Finish your profile in {workspaceName}',
        lines: [
          'Your profile has no time zone yet, so due dates and meeting times are shown in the workspace time.',
          'Adding your time zone, name and photo takes a minute and helps your team know when you are around.',
        ],
        button: 'Open my settings',
        close: 'If a setting is unclear, reply and I will explain it.',
      },
      ar: {
        subject: 'أكمل ملفك الشخصي في {workspaceName}',
        lines: [
          'لم تحدّد منطقتك الزمنية بعد، لذلك تظهر مواعيد التسليم والاجتماعات بتوقيت مساحة العمل.',
          'إضافة منطقتك الزمنية واسمك وصورتك تأخذ دقيقة، وتساعد فريقك على معرفة أوقات تواجدك.',
        ],
        button: 'افتح إعداداتي',
        close: 'إذا كان أي إعداد غير واضح، ردّ عليّ وسأشرحه لك.',
      },
    },
  },
  {
    id: 'onboarding:invited_not_joined',
    topic: 'onboarding',
    audience: 'member',
    capability: 'people.invite',
    cap: 'normal',
    priority: 6,
    enabled: true,
    when: (f) => f.ownStaleInvitations > 0,
    count: (f) => f.ownStaleInvitations,
    link: '/people',
    copy: {
      en: {
        subject: 'Your invitation to {workspaceName} is still open',
        lines: [
          'People you invited to {workspaceName} have not joined yet ({count} open for more than three days).',
          'An invitation sometimes lands in spam. You can send it again from the People page.',
        ],
        button: 'Resend from People',
        close: 'If someone cannot find the e-mail, reply and I will help.',
      },
      ar: {
        subject: 'دعوتك إلى {workspaceName} ما زالت مفتوحة',
        lines: [
          'لم ينضم بعد أشخاص دعوتهم إلى {workspaceName} (عدد الدعوات المفتوحة منذ أكثر من ثلاثة أيام: {count}).',
          'أحيانًا تصل الدعوة إلى البريد المزعج. يمكنك إرسالها مرة أخرى من صفحة الأشخاص.',
        ],
        button: 'أعد الإرسال من صفحة الأشخاص',
        close: 'إذا لم يجد أحد الرسالة، ردّ عليّ وسأساعدك.',
      },
    },
  },
  {
    id: 'onboarding:first_week_recap',
    topic: 'onboarding',
    audience: 'member',
    capability: null,
    cap: 'normal',
    priority: 7,
    enabled: false,
    disabledReason: 'a recap needs per-user activity counts for the week; no cheap indexed test',
    when: () => false,
    link: '/home',
    copy: {
      en: {
        subject: 'Your first week in {workspaceName}',
        lines: [
          'Here is what you did in your first week, and one next step that usually helps teams like yours.',
        ],
        button: 'Open {workspaceName}',
        close: 'Reply and tell me what you would like TManage to do better for you.',
      },
      ar: {
        subject: 'أسبوعك الأول في {workspaceName}',
        lines: ['هذا ما أنجزته في أسبوعك الأول، وخطوة تالية تفيد عادةً فرقًا مثل فريقك.'],
        button: 'افتح {workspaceName}',
        close: 'ردّ عليّ وأخبرني بما تريد أن يحسّنه TManage لك.',
      },
    },
  },
  // ---- features: half-finished set-ups ----
  {
    id: 'setup:calendar_no_meeting',
    topic: 'features',
    audience: 'member',
    capability: 'meeting.write',
    cap: 'normal',
    priority: 8,
    enabled: true,
    when: (f) =>
      memberAge(f) >= 3 &&
      f.personalUsed.has('calendar_connection') &&
      !f.workspaceUsed.has('meetings'),
    link: '/calendar/new',
    copy: {
      en: {
        subject: 'Your calendar is connected; plan the first meeting',
        lines: [
          'Your calendar is connected, but {workspaceName} has no meeting yet. A meeting planned in TManage keeps its agenda, notes and follow-up tasks with the project, and it appears in your calendar too.',
        ],
        button: 'Plan a meeting',
        close: 'If the calendar shows something odd, reply and I will look into it with you.',
      },
      ar: {
        subject: 'تقويمك مربوط، خطّط لأول اجتماع',
        lines: [
          'تقويمك مربوط، لكن لا يوجد اجتماع في {workspaceName} بعد. الاجتماع الذي تخطّط له في TManage يحتفظ بجدول أعماله وملاحظاته ومهام المتابعة مع المشروع، ويظهر في تقويمك أيضًا.',
        ],
        button: 'خطّط لاجتماع',
        close: 'إذا ظهر شيء غريب في التقويم، ردّ عليّ وسنبحثه معًا.',
      },
    },
  },
  {
    id: 'setup:project_without_tasks',
    topic: 'features',
    audience: 'member',
    capability: 'work.create',
    cap: 'normal',
    priority: 9,
    enabled: true,
    when: (f) =>
      workspaceAge(f) >= 3 && f.workspaceUsed.has('projects') && !f.workspaceUsed.has('work_items'),
    link: '/work',
    copy: {
      en: {
        subject: 'Your project in {workspaceName} has no tasks yet',
        lines: [
          'There is a project in {workspaceName}, but no task in it yet. Breaking the work into a few tasks with dates shows everyone what comes next.',
        ],
        button: 'Add a task',
        close: 'Not sure how small a task should be? Reply and I will share what works.',
      },
      ar: {
        subject: 'مشروعك في {workspaceName} بلا مهام حتى الآن',
        lines: [
          'يوجد مشروع في {workspaceName}، لكن لا توجد فيه مهام بعد. تقسيم العمل إلى بضع مهام بمواعيد يوضح للجميع ما الخطوة التالية.',
        ],
        button: 'أضف مهمة',
        close: 'لا تعرف ما الحجم المناسب للمهمة؟ ردّ عليّ وسأشاركك ما ينجح عادةً.',
      },
    },
  },
  {
    id: 'setup:client_never_signed_in',
    topic: 'features',
    audience: 'member',
    capability: 'client_member.manage',
    cap: 'normal',
    priority: 11,
    enabled: false,
    disabledReason: 'needs the client sign-in history per client; no cheap indexed test',
    when: () => false,
    link: '/clients',
    copy: {
      en: {
        subject: 'Your client has not opened the portal yet',
        lines: [
          'A client you invited to {workspaceName} has not signed in to the portal yet. A short note from you with the link usually helps.',
        ],
        button: 'Open clients',
        close: 'Reply if you want to know what your client will see first.',
      },
      ar: {
        subject: 'عميلك لم يفتح البوابة بعد',
        lines: [
          'عميل دعوته إلى {workspaceName} لم يسجّل الدخول إلى البوابة بعد. رسالة قصيرة منك مع الرابط تساعد عادةً.',
        ],
        button: 'افتح العملاء',
        close: 'ردّ عليّ إذا أردت أن تعرف ما سيراه عميلك أولًا.',
      },
    },
  },
  {
    id: 'setup:approval_waiting',
    topic: 'features',
    audience: 'member',
    capability: 'deliverable.create',
    cap: 'normal',
    priority: 13,
    enabled: false,
    disabledReason:
      'needs open approvals by age; approvals has no (organization, state, age) index',
    when: () => false,
    link: '/files',
    copy: {
      en: {
        subject: 'An approval has been waiting for more than five days',
        lines: [
          'An approval request in {workspaceName} has been open for more than five days. A reminder to the reviewer often gets it moving.',
        ],
        button: 'Open approvals',
        close: 'Reply if a reviewer cannot open it.',
      },
      ar: {
        subject: 'طلب اعتماد ينتظر منذ أكثر من خمسة أيام',
        lines: [
          'طلب اعتماد في {workspaceName} مفتوح منذ أكثر من خمسة أيام. تذكير المراجع يحرّكه غالبًا.',
        ],
        button: 'افتح الاعتمادات',
        close: 'ردّ عليّ إذا لم يستطع المراجع فتحه.',
      },
    },
  },
  {
    id: 'setup:files_not_shared',
    topic: 'features',
    audience: 'member',
    capability: 'deliverable.publish',
    cap: 'normal',
    priority: 15,
    enabled: false,
    disabledReason: 'needs files joined to client visibility; no cheap indexed test',
    when: () => false,
    link: '/files',
    copy: {
      en: {
        subject: 'Your files are not shared with a client yet',
        lines: [
          'The files in {workspaceName} are visible to your team only. Share the ones a client should see, and they appear in the client portal.',
        ],
        button: 'Open files',
        close: 'Reply if you want to check what a client would see.',
      },
      ar: {
        subject: 'ملفاتك غير مشاركة مع أي عميل بعد',
        lines: [
          'الملفات في {workspaceName} يراها فريقك فقط. شارك ما يجب أن يراه العميل، وسيظهر في بوابة العميل.',
        ],
        button: 'افتح الملفات',
        close: 'ردّ عليّ إذا أردت أن تتأكد مما سيراه العميل.',
      },
    },
  },
  // ---- news (feature news notes are built per note, see `newsKind`) ----
  {
    id: 'news:changed_feature',
    topic: 'news',
    audience: 'member',
    capability: null,
    cap: 'news',
    priority: 100,
    enabled: false,
    disabledReason: 'needs a link between release notes and the features a user uses',
    when: () => false,
    link: '/home',
    copy: {
      en: {
        subject: 'A change to something you use in TManage',
        lines: ['A feature you use in {workspaceName} works a little differently now.'],
        button: 'See what changed',
        close: 'Questions about it? Reply to me.',
      },
      ar: {
        subject: 'تغيير في شيء تستخدمه في TManage',
        lines: ['ميزة تستخدمها في {workspaceName} أصبحت تعمل بشكل مختلف قليلًا.'],
        button: 'اعرف ما الذي تغيّر',
        close: 'عندك سؤال عنه؟ ردّ عليّ.',
      },
    },
  },
  {
    id: 'news:maintenance',
    topic: 'news',
    audience: 'member',
    capability: null,
    cap: 'news',
    priority: 101,
    enabled: false,
    disabledReason:
      'maintenance windows are not yet published to tenants through a worker-readable row',
    when: () => false,
    link: '/home',
    copy: {
      en: {
        subject: 'Planned maintenance for TManage',
        lines: ['TManage will be unavailable for a short time during planned maintenance.'],
        button: 'See the time',
        close: 'If the time is bad for your team, reply and tell me.',
      },
      ar: {
        subject: 'صيانة مخطّطة لـ TManage',
        lines: ['سيكون TManage غير متاح لفترة قصيرة أثناء صيانة مخطّطة.'],
        button: 'اعرف الموعد',
        close: 'إذا كان الموعد غير مناسب لفريقك، ردّ عليّ وأخبرني.',
      },
    },
  },
  // ---- security follow-ups (never codes, never a sign-in link) ----
  {
    id: 'security:after_new_device',
    topic: 'security',
    audience: 'member',
    capability: null,
    cap: 'outside',
    priority: 0,
    enabled: true,
    when: (f) =>
      f.newDeviceNoticeAt !== null &&
      days(f.newDeviceNoticeAt, f.now) >= 1 &&
      days(f.newDeviceNoticeAt, f.now) < 7,
    link: '/settings/security',
    copy: {
      en: {
        subject: 'About the new sign-in to your account',
        lines: [
          'Your TManage account was signed in to from a new device yesterday, and the security notice went out then.',
          'If it was you, nothing to do. If not, change your password from security settings and reply to me so we look into it.',
          SECURITY_PROMISE_EN,
        ],
        button: 'Open security settings',
        close: 'Reply to me if anything looks wrong.',
      },
      ar: {
        subject: 'بخصوص الدخول الجديد إلى حسابك',
        lines: [
          'سُجّل الدخول إلى حسابك في TManage من جهاز جديد أمس، وأُرسل إشعار الأمان وقتها.',
          'إن كنت أنت فلا شيء مطلوب منك. وإن لم تكن أنت، غيّر كلمة مرورك من إعدادات الأمان وردّ عليّ لنتحقق من الأمر.',
          SECURITY_PROMISE_AR,
        ],
        button: 'افتح إعدادات الأمان',
        close: 'ردّ عليّ إذا بدا لك أي شيء غير طبيعي.',
      },
    },
  },
  {
    id: 'security:owner_policy',
    topic: 'security',
    audience: 'owner',
    capability: 'org.security.manage',
    cap: 'normal',
    priority: 20,
    enabled: true,
    when: (f) => workspaceAge(f) >= 14 && f.activeMembers >= 3 && !f.hasSignInPolicy,
    link: '/admin/security',
    copy: {
      en: {
        subject: 'Sign-in rules for {workspaceName}',
        lines: [
          '{workspaceName} has three or more people and no sign-in rules yet. You can choose which sign-in methods are allowed and who must use a second step.',
          SECURITY_PROMISE_EN,
        ],
        button: 'Open security settings',
        close: 'Not sure which rules suit your team? Reply and I will help you choose.',
      },
      ar: {
        subject: 'قواعد الدخول في {workspaceName}',
        lines: [
          'في {workspaceName} ثلاثة أشخاص أو أكثر ولا توجد قواعد لتسجيل الدخول بعد. يمكنك اختيار طرق الدخول المسموحة ومن يجب أن يستخدم خطوة ثانية.',
          SECURITY_PROMISE_AR,
        ],
        button: 'افتح إعدادات الأمان',
        close: 'لا تعرف أي القواعد تناسب فريقك؟ ردّ عليّ وسأساعدك في الاختيار.',
      },
    },
  },
  {
    id: 'security:two_step_off',
    topic: 'security',
    audience: 'member',
    capability: null,
    cap: 'normal',
    priority: 21,
    enabled: false,
    disabledReason:
      'needs user_mfa_factors/user_passkeys, which hold the TOTP secret and passkeys; the worker is not granted a read on them',
    when: () => false,
    link: '/settings/two-step',
    copy: {
      en: {
        subject: 'Protect your TManage sign-in',
        lines: [
          'Your account has no second sign-in step yet. With one, a stolen password alone is not enough to get in.',
          SECURITY_PROMISE_EN,
        ],
        button: 'Open security settings',
        close: 'Not sure which option suits you? Reply and I will help you choose.',
      },
      ar: {
        subject: 'احمِ دخولك إلى TManage',
        lines: [
          'لا توجد خطوة ثانية لتسجيل الدخول في حسابك بعد. مع الخطوة الثانية لا تكفي كلمة مرور مسروقة وحدها للدخول.',
          SECURITY_PROMISE_AR,
        ],
        button: 'افتح إعدادات الأمان',
        close: 'لا تعرف أي خيار يناسبك؟ ردّ عليّ وسأساعدك في الاختيار.',
      },
    },
  },
  {
    id: 'security:recovery_codes_missing',
    topic: 'security',
    audience: 'member',
    capability: null,
    cap: 'normal',
    priority: 22,
    enabled: false,
    disabledReason:
      'needs user_recovery_codes and the factor tables; the worker is not granted a read on them',
    when: () => false,
    link: '/settings/two-step',
    copy: {
      en: {
        subject: 'Keep a way back into your account',
        lines: [
          'Your second sign-in step is on, but you have no recovery codes. If you lose your phone, a recovery code is how you get back in.',
          SECURITY_PROMISE_EN,
        ],
        button: 'Open security settings',
        close: 'Reply if you are unsure where to keep them.',
      },
      ar: {
        subject: 'احتفظ بطريقة للعودة إلى حسابك',
        lines: [
          'الخطوة الثانية لتسجيل الدخول مفعّلة، لكن ليس لديك رموز استرداد. إن فقدت هاتفك، فرمز الاسترداد هو طريقك للعودة.',
          SECURITY_PROMISE_AR,
        ],
        button: 'افتح إعدادات الأمان',
        close: 'ردّ عليّ إذا لم تكن متأكدًا أين تحفظها.',
      },
    },
  },
  {
    id: 'security:password_old',
    topic: 'security',
    audience: 'member',
    capability: null,
    cap: 'normal',
    priority: 23,
    enabled: false,
    disabledReason: 'needs user_passwords (the hash table); the worker is not granted a read on it',
    when: () => false,
    link: '/settings/security',
    copy: {
      en: {
        subject: 'Your password is more than a year old',
        lines: [
          'Your TManage password has not changed in more than twelve months. A new, long password you use nowhere else keeps the account safe.',
          SECURITY_PROMISE_EN,
        ],
        button: 'Open security settings',
        close: 'Reply if you would like advice on a good password.',
      },
      ar: {
        subject: 'عمر كلمة مرورك أكثر من سنة',
        lines: [
          'لم تتغيّر كلمة مرورك في TManage منذ أكثر من اثني عشر شهرًا. كلمة مرور جديدة وطويلة لا تستخدمها في مكان آخر تحمي حسابك.',
          SECURITY_PROMISE_AR,
        ],
        button: 'افتح إعدادات الأمان',
        close: 'ردّ عليّ إذا أردت نصيحة لكلمة مرور جيدة.',
      },
    },
  },
  {
    id: 'security:members_without_two_step',
    topic: 'security',
    audience: 'owner',
    capability: 'org.security.manage',
    cap: 'normal',
    priority: 24,
    enabled: false,
    disabledReason:
      'needs a count over the factor tables; the worker is not granted a read on them',
    when: () => false,
    link: '/admin/security',
    count: () => 0,
    copy: {
      en: {
        subject: 'Some people in {workspaceName} have no second sign-in step',
        lines: [
          '{count} people in {workspaceName} sign in with a password only. You can require a second step for everyone or for admins.',
          SECURITY_PROMISE_EN,
        ],
        button: 'Open security settings',
        close: 'Reply if you want help deciding.',
      },
      ar: {
        subject: 'بعض الأشخاص في {workspaceName} بلا خطوة ثانية للدخول',
        lines: [
          'يسجّل {count} من الأشخاص في {workspaceName} الدخول بكلمة المرور فقط. يمكنك طلب خطوة ثانية من الجميع أو من المسؤولين.',
          SECURITY_PROMISE_AR,
        ],
        button: 'افتح إعدادات الأمان',
        close: 'ردّ عليّ إذا أردت مساعدة في القرار.',
      },
    },
  },
  {
    id: 'security:public_link_open',
    topic: 'security',
    audience: 'owner_admin',
    capability: 'org.manage',
    cap: 'normal',
    priority: 25,
    enabled: false,
    disabledReason:
      'needs public_links by age (token hashes); the worker is not granted a read on it',
    when: () => false,
    link: '/admin/public-links',
    copy: {
      en: {
        subject: 'A shared link in {workspaceName} is still open',
        lines: [
          'A public link in {workspaceName} has been open for more than 60 days without being used. Closing links you no longer need keeps your files private.',
          SECURITY_PROMISE_EN,
        ],
        button: 'Review public links',
        close: 'Reply if you are unsure which links are still needed.',
      },
      ar: {
        subject: 'رابط مشاركة في {workspaceName} ما زال مفتوحًا',
        lines: [
          'رابط عام في {workspaceName} مفتوح منذ أكثر من 60 يومًا دون استخدام. إغلاق الروابط التي لم تعد تحتاجها يحافظ على خصوصية ملفاتك.',
          SECURITY_PROMISE_AR,
        ],
        button: 'راجع الروابط العامة',
        close: 'ردّ عليّ إذا لم تكن متأكدًا أي الروابط ما زالت مطلوبة.',
      },
    },
  },
  // ---- success ----
  {
    id: 'success:quiet_checkin',
    topic: 'success',
    audience: 'owner_admin',
    capability: null,
    cap: 'normal',
    priority: 30,
    enabled: true,
    when: (f) =>
      workspaceAge(f) >= 21 &&
      f.workspaceLastSignInAt !== null &&
      days(f.workspaceLastSignInAt, f.now) >= 14,
    link: '/home',
    copy: {
      en: {
        subject: 'Is anything in the way?',
        lines: [
          "Nobody has opened {workspaceName} for two weeks. If something got in the way, or TManage didn't fit how you work, I'd like to hear it.",
        ],
        button: 'Open {workspaceName}',
        close: 'One line in reply is enough.',
      },
      ar: {
        subject: 'هل هناك ما يعطّلك؟',
        lines: [
          'لم يفتح أحد {workspaceName} منذ أسبوعين. إذا كان هناك ما عطّلك، أو لم يناسب TManage طريقة شغلك، أحب أن أعرف.',
        ],
        button: 'افتح {workspaceName}',
        close: 'سطر واحد في الردّ يكفي.',
      },
    },
  },
  {
    id: 'success:winback',
    topic: 'success',
    audience: 'member',
    capability: null,
    cap: 'normal',
    priority: 31,
    enabled: true,
    when: (f) => f.userLastSignInAt !== null && days(f.userLastSignInAt, f.now) >= 45,
    link: '/home',
    copy: {
      en: {
        subject: 'Your work in {workspaceName} is still here',
        lines: [
          'You have not opened {workspaceName} in a while. Your projects, files and messages are where you left them.',
        ],
        button: 'Open {workspaceName}',
        close: 'If TManage stopped fitting your work, a line in reply helps us make it better.',
      },
      ar: {
        subject: 'عملك في {workspaceName} ما زال هنا',
        lines: ['لم تفتح {workspaceName} منذ فترة. مشاريعك وملفاتك ورسائلك في مكانها كما تركتها.'],
        button: 'افتح {workspaceName}',
        close: 'إذا لم يعد TManage يناسب شغلك، فسطر في الردّ يساعدنا على تحسينه.',
      },
    },
  },
  {
    id: 'success:feedback_30d',
    topic: 'success',
    audience: 'member',
    capability: null,
    cap: 'normal',
    priority: 32,
    enabled: true,
    when: (f) => memberAge(f) >= 30,
    link: '/home',
    copy: {
      en: {
        subject: 'One question about TManage',
        lines: [
          'You have used {workspaceName} for a month now. What is the one thing you would change?',
        ],
        button: 'Open {workspaceName}',
        close: 'Reply with one line; I read every answer.',
      },
      ar: {
        subject: 'سؤال واحد عن TManage',
        lines: ['مرّ شهر على استخدامك {workspaceName}. ما الشيء الواحد الذي تودّ تغييره؟'],
        button: 'افتح {workspaceName}',
        close: 'ردّ بسطر واحد، فكل إجابة تُقرأ.',
      },
    },
  },
  {
    id: 'success:one_month',
    topic: 'success',
    audience: 'member',
    capability: null,
    cap: 'normal',
    priority: 33,
    enabled: true,
    when: (f) => memberAge(f) >= 30 && memberAge(f) < 37,
    link: '/home',
    copy: {
      en: {
        subject: 'One month in {workspaceName}',
        lines: [
          'It has been a month since you joined {workspaceName}. Thank you for working with TManage.',
        ],
        button: 'Open {workspaceName}',
        close: 'Nothing to do; this is only a thank-you.',
      },
      ar: {
        subject: 'شهر في {workspaceName}',
        lines: ['مرّ شهر على انضمامك إلى {workspaceName}. شكرًا لأنك تعمل مع TManage.'],
        button: 'افتح {workspaceName}',
        close: 'لا شيء مطلوب منك، هذه رسالة شكر فقط.',
      },
    },
  },
  {
    id: 'success:one_year',
    topic: 'success',
    audience: 'member',
    capability: null,
    cap: 'normal',
    priority: 34,
    enabled: true,
    when: (f) => memberAge(f) >= 365 && memberAge(f) < 372,
    link: '/home',
    copy: {
      en: {
        subject: 'One year in {workspaceName}',
        lines: [
          'It has been a year since you joined {workspaceName}. Thank you for a year with TManage.',
        ],
        button: 'Open {workspaceName}',
        close: 'Nothing to do; this is only a thank-you.',
      },
      ar: {
        subject: 'سنة في {workspaceName}',
        lines: ['مرّت سنة على انضمامك إلى {workspaceName}. شكرًا على سنة مع TManage.'],
        button: 'افتح {workspaceName}',
        close: 'لا شيء مطلوب منك، هذه رسالة شكر فقط.',
      },
    },
  },
  {
    id: 'success:tenth_file',
    topic: 'success',
    audience: 'owner_admin',
    capability: null,
    cap: 'normal',
    priority: 35,
    enabled: true,
    when: (f) => f.tenFiles,
    link: '/files',
    copy: {
      en: {
        subject: '{workspaceName} now holds ten files',
        lines: [
          'Your team has put ten files into {workspaceName}. Thank you for keeping the work in one place.',
        ],
        button: 'Open files',
        close: 'Nothing to do; this is only a thank-you.',
      },
      ar: {
        subject: 'أصبح في {workspaceName} عشرة ملفات',
        lines: [
          'أضاف فريقك عشرة ملفات إلى {workspaceName}. شكرًا لأنكم تجمعون العمل في مكان واحد.',
        ],
        button: 'افتح الملفات',
        close: 'لا شيء مطلوب منك، هذه رسالة شكر فقط.',
      },
    },
  },
  {
    id: 'success:first_approval',
    topic: 'success',
    audience: 'owner_admin',
    capability: null,
    cap: 'normal',
    priority: 36,
    enabled: true,
    when: (f) => f.workspaceUsed.has('approvals'),
    link: '/files',
    copy: {
      en: {
        subject: 'The first approval in {workspaceName}',
        lines: ['{workspaceName} has its first approval request. Thank you for trying it.'],
        button: 'Open files',
        close: 'Nothing to do; this is only a thank-you.',
      },
      ar: {
        subject: 'أول اعتماد في {workspaceName}',
        lines: ['أصبح في {workspaceName} أول طلب اعتماد. شكرًا لأنك جرّبته.'],
        button: 'افتح الملفات',
        close: 'لا شيء مطلوب منك، هذه رسالة شكر فقط.',
      },
    },
  },
  {
    id: 'success:first_project_done',
    topic: 'success',
    audience: 'owner_admin',
    capability: null,
    cap: 'normal',
    priority: 37,
    enabled: false,
    disabledReason: 'needs projects by state; projects has no (organization, state) index',
    when: () => false,
    link: '/projects/portfolio',
    copy: {
      en: {
        subject: 'Your first finished project in {workspaceName}',
        lines: ['A project in {workspaceName} is finished. Thank you for running it with TManage.'],
        button: 'Open projects',
        close: 'Nothing to do; this is only a thank-you.',
      },
      ar: {
        subject: 'أول مشروع منجز في {workspaceName}',
        lines: ['اكتمل مشروع في {workspaceName}. شكرًا لأنك أدرته مع TManage.'],
        button: 'افتح المشاريع',
        close: 'لا شيء مطلوب منك، هذه رسالة شكر فقط.',
      },
    },
  },
  {
    id: 'success:storage_room',
    topic: 'success',
    audience: 'owner',
    capability: 'storage.manage',
    cap: 'normal',
    priority: 38,
    enabled: false,
    disabledReason:
      'needs the date of the last storage notice (N15) per workspace; not kept in a row the worker can probe',
    when: () => false,
    link: '/admin/storage',
    copy: {
      en: {
        subject: 'Room for your files',
        lines: [
          '{workspaceName} is close to its storage limit. Connecting Google Drive or OneDrive keeps new files in your own account, so the limit stops mattering.',
        ],
        button: 'Connect storage',
        close: 'Reply if you want help choosing.',
      },
      ar: {
        subject: 'مساحة لملفاتك',
        lines: [
          'اقتربت {workspaceName} من حد التخزين. ربط Google Drive أو OneDrive يحفظ الملفات الجديدة في حسابك أنت، فلا يعود الحد مشكلة.',
        ],
        button: 'اربط التخزين',
        close: 'ردّ عليّ إذا أردت مساعدة في الاختيار.',
      },
    },
  },
  {
    id: 'success:limits_close',
    topic: 'success',
    audience: 'owner',
    capability: 'billing.view',
    cap: 'normal',
    priority: 39,
    enabled: false,
    disabledReason: 'needs plan usage against limits; computed by the billing service, not a probe',
    when: () => false,
    link: '/billing',
    copy: {
      en: {
        subject: '{workspaceName} is close to its plan limit',
        lines: [
          '{workspaceName} is close to a limit of its plan. Here is how to make room before anything stops.',
        ],
        button: 'Open billing',
        close: 'Reply if you want advice on the right plan.',
      },
      ar: {
        subject: 'اقتربت {workspaceName} من حد خطتها',
        lines: [
          'اقتربت {workspaceName} من أحد حدود خطتها. هذه طريقة لتوفير مساحة قبل أن يتوقف شيء.',
        ],
        button: 'افتح الفوترة',
        close: 'ردّ عليّ إذا أردت نصيحة بالخطة المناسبة.',
      },
    },
  },
  {
    id: 'success:exit_question',
    topic: 'success',
    audience: 'owner',
    capability: null,
    cap: 'normal',
    priority: 40,
    enabled: false,
    disabledReason:
      'a workspace scheduled for deletion is outside the sweep (deleted workspaces are never candidates)',
    when: () => false,
    link: '/home',
    copy: {
      en: {
        subject: 'Before {workspaceName} goes',
        lines: [
          '{workspaceName} is scheduled for deletion. If you have a moment, what made you decide to leave?',
        ],
        button: 'Open {workspaceName}',
        close: 'One line in reply is enough, and it is read.',
      },
      ar: {
        subject: 'قبل حذف {workspaceName}',
        lines: ['{workspaceName} مجدولة للحذف. إن كان لديك وقت، ما الذي جعلك تقرّر المغادرة؟'],
        button: 'افتح {workspaceName}',
        close: 'سطر واحد في الردّ يكفي، وهو يُقرأ.',
      },
    },
  },
];

/** The whole catalog: hand-written kinds, every feature, every better-use tip. */
export const PERSON_MAIL_CATALOG: readonly PersonMailKind[] = [
  ...KINDS,
  ...FEATURES.map(featureKind),
  ...BETTER_USE.map((tip, index) => betterUseKind(tip, 200 + index)),
];

/** A feature-news note, as a send-once kind. */
export interface FeatureNewsNote {
  readonly id: string;
  readonly titleEn: string;
  readonly titleAr: string;
  readonly bodyEn: string;
  readonly bodyAr: string;
  readonly link: string;
}

export function newsKind(note: FeatureNewsNote): PersonMailKind {
  return {
    // `mail_tip_log.tip_id` is at most 40 ASCII: the UUID without its dashes (37 in all).
    id: `news:${note.id.replaceAll('-', '')}`,
    topic: 'news',
    audience: 'member',
    capability: null,
    cap: 'news',
    priority: 50,
    enabled: true,
    when: () => true,
    link: note.link,
    copy: {
      en: {
        subject: `New in TManage: ${note.titleEn}`,
        lines: [note.bodyEn],
        button: 'See it',
        close: 'Questions about it? Reply to me.',
      },
      ar: {
        subject: `جديد في TManage: ${note.titleAr}`,
        lines: [note.bodyAr],
        button: 'شاهده',
        close: 'عندك سؤال عنه؟ ردّ عليّ.',
      },
    },
  };
}
