import type {
  ProjectTemplateMilestone,
  ProjectTemplateWorkItem,
} from '../../common/database/schema.js';

/**
 * 54-22. The built-in template packs. A pack is a bundle of project templates plus the docs and
 * automations that go with them. The packs live in code, not in the database, so shipping or
 * changing one is a deploy and never a data change; `template_packs` (0325) only records which
 * packs a workspace installed.
 *
 * Installing a pack creates its project templates. The pack's docs and automations are written
 * into each template's description as setup steps, so the person starting a project from the
 * template sees what to add; nothing is switched on behind their back.
 */

export interface TemplatePackTemplate {
  readonly name: string;
  readonly description: string;
  readonly defaultObjectives?: readonly string[];
  readonly milestones?: readonly ProjectTemplateMilestone[];
  readonly workItems?: readonly ProjectTemplateWorkItem[];
  readonly clientPortalOn?: boolean;
  readonly repeatInterval?: 'monthly';
}

/** 55-02. The roles a starter pack is meant for; the gallery and the onboarding wizard filter on them. */
export const PACK_ROLES = [
  'agency_owner',
  'project_manager',
  'designer',
  'developer',
  'marketing',
  'accounting',
] as const;
export type PackRole = (typeof PACK_ROLES)[number];

/** 54-23. The working week a pack's dates are laid out on. */
export type PackWorkWeek = 'mon_fri' | 'sun_thu';

export interface TemplatePack {
  /** Stable catalog key, stored in `template_packs.pack_key`. */
  readonly key: string;
  /** 55-02. Who the pack is for; a pack can suit several roles. */
  readonly roles: readonly PackRole[];
  /** 54-23. The language the pack is written in; `ar` packs are shown with an "Arabic" badge. */
  readonly language: 'en' | 'ar';
  /** 54-23. The working week the offsets assume, counted from the first working day. */
  readonly workWeek: PackWorkWeek;
  readonly name: string;
  readonly description: string;
  readonly templates: readonly TemplatePackTemplate[];
  /** Titles of the docs the pack suggests. */
  readonly docs: readonly string[];
  /** Plain descriptions of the automations the pack suggests. */
  readonly automations: readonly string[];
}

export const TEMPLATE_PACKS: readonly TemplatePack[] = [
  {
    key: 'agency-client-launch',
    roles: ['agency_owner', 'project_manager', 'designer'],
    language: 'en',
    workWeek: 'mon_fri',
    name: 'Agency client launch',
    description: 'Kick-off, brand sprint and website launch for a new client.',
    templates: [
      {
        name: 'Client kick-off',
        description: 'Welcome a new client and agree the brief.',
        milestones: [
          { title: 'Kick-off meeting', offsetDays: 0 },
          { title: 'Brief signed off', offsetDays: 7, clientVisible: true },
        ],
        workItems: [
          { title: 'Send the welcome pack', offsetDays: 0 },
          { title: 'Book the kick-off call', offsetDays: 1 },
          { title: 'Collect brand assets', offsetDays: 3 },
        ],
        clientPortalOn: true,
      },
      {
        name: 'Brand sprint',
        description: 'Two weeks from moodboards to an approved brand direction.',
        milestones: [
          { title: 'Moodboards shared', offsetDays: 5, clientVisible: true },
          { title: 'Brand direction approved', offsetDays: 14, clientVisible: true },
        ],
        workItems: [
          { title: 'Research the market', offsetDays: 2 },
          { title: 'Prepare three moodboards', offsetDays: 5 },
          { title: 'Present the brand direction', offsetDays: 12 },
        ],
        clientPortalOn: true,
      },
      {
        name: 'Website launch',
        description: 'Sitemap, design and build through to a live site.',
        milestones: [
          { title: 'Sitemap approved', offsetDays: 7, clientVisible: true },
          { title: 'Design approved', offsetDays: 21, clientVisible: true },
          { title: 'Site live', offsetDays: 42, clientVisible: true },
        ],
        workItems: [
          { title: 'Draft the sitemap', offsetDays: 3 },
          { title: 'Design the key pages', offsetDays: 18 },
          { title: 'Build and test', offsetDays: 38 },
        ],
        clientPortalOn: true,
      },
    ],
    docs: ['Client onboarding guide', 'Creative brief'],
    automations: [
      'Tell the client when a milestone is done',
      'Remind the lead two days before a due date',
    ],
  },
  {
    key: 'monthly-retainer',
    roles: ['agency_owner', 'project_manager', 'accounting'],
    language: 'en',
    workWeek: 'mon_fri',
    name: 'Monthly retainer',
    description: 'A repeating month of client work with a report at the end.',
    templates: [
      {
        name: 'Monthly retainer',
        description: 'One month of agreed client work that repeats every month.',
        workItems: [
          { title: 'Plan the month with the client', offsetDays: 0 },
          { title: 'Mid-month check-in', offsetDays: 14 },
          { title: 'Send the month-end report', offsetDays: 27 },
        ],
        clientPortalOn: true,
        repeatInterval: 'monthly',
      },
      {
        name: 'Quarterly review',
        description: 'Look back on the quarter with the client and agree the next one.',
        milestones: [{ title: 'Quarterly review meeting', offsetDays: 0, clientVisible: true }],
        workItems: [
          { title: 'Gather the quarter’s results', offsetDays: 0 },
          { title: 'Agree next quarter’s goals', offsetDays: 3 },
        ],
      },
    ],
    docs: ['Monthly report outline'],
    automations: ['Start the next month’s retainer on the first of the month'],
  },
  {
    key: 'product-sprint-kit',
    roles: ['project_manager', 'developer'],
    language: 'en',
    workWeek: 'mon_fri',
    name: 'Product sprint kit',
    description: 'Discovery, a two-week build sprint and a release checklist.',
    templates: [
      {
        name: 'Discovery',
        description: 'Understand the problem before building anything.',
        defaultObjectives: ['Agree the problem we are solving'],
        milestones: [{ title: 'Problem statement agreed', offsetDays: 5 }],
        workItems: [
          { title: 'Interview five users', offsetDays: 3 },
          { title: 'Write the problem statement', offsetDays: 5 },
        ],
      },
      {
        name: 'Two-week build sprint',
        description: 'Plan, build and demo in two weeks.',
        milestones: [
          { title: 'Sprint planned', offsetDays: 0 },
          { title: 'Sprint demo', offsetDays: 13 },
        ],
        workItems: [
          { title: 'Sprint planning', offsetDays: 0 },
          { title: 'Daily stand-ups', offsetDays: 1 },
          { title: 'Sprint review and retro', offsetDays: 13 },
        ],
      },
    ],
    docs: ['Problem statement', 'Release checklist'],
    automations: ['Post a sprint summary in the project chat'],
  },
  // 55-02. Starter packs by role: one small pack per role, offered in the onboarding wizard.
  {
    key: 'starter-agency-owner',
    roles: ['agency_owner'],
    language: 'en',
    workWeek: 'mon_fri',
    name: 'Agency owner starter',
    description: 'Pipeline review, team weekly planning and a monthly look at the numbers.',
    templates: [
      {
        name: 'Agency pipeline review',
        description: 'Go through new leads and proposals with the team every week.',
        workItems: [
          { title: 'List the open proposals', offsetDays: 0 },
          { title: 'Agree who follows up each lead', offsetDays: 1 },
          { title: 'Review the month’s numbers', offsetDays: 21 },
        ],
      },
      {
        name: 'Team weekly planning',
        description: 'Plan the team’s week and spot who is overloaded.',
        workItems: [
          { title: 'Check everyone’s workload', offsetDays: 0 },
          { title: 'Agree the week’s priorities', offsetDays: 0 },
          { title: 'End-of-week wrap-up', offsetDays: 4 },
        ],
      },
    ],
    docs: ['Agency playbook'],
    automations: ['Send the owner a Monday summary of overdue work'],
  },
  {
    key: 'starter-project-manager',
    roles: ['project_manager'],
    language: 'en',
    workWeek: 'mon_fri',
    name: 'Project manager starter',
    description: 'A project plan with a kick-off, milestones and a weekly status report.',
    templates: [
      {
        name: 'Project plan and kick-off',
        description: 'Agree scope, owners and dates before the work starts.',
        defaultObjectives: ['Deliver on the agreed date'],
        milestones: [
          { title: 'Kick-off held', offsetDays: 0 },
          { title: 'Plan signed off', offsetDays: 7, clientVisible: true },
        ],
        workItems: [
          { title: 'Write the scope', offsetDays: 1 },
          { title: 'Name an owner for each milestone', offsetDays: 2 },
        ],
      },
      {
        name: 'Weekly status report',
        description: 'A short report every week: done, next, at risk.',
        workItems: [
          { title: 'Collect updates from the team', offsetDays: 3 },
          { title: 'Send the status report', offsetDays: 4 },
        ],
      },
    ],
    docs: ['Status report outline'],
    automations: ['Remind owners two days before a milestone is due'],
  },
  {
    key: 'starter-designer',
    roles: ['designer'],
    language: 'en',
    workWeek: 'mon_fri',
    name: 'Designer starter',
    description: 'Design review rounds with client feedback and a tidy asset library.',
    templates: [
      {
        name: 'Design review cycle',
        description: 'Share, collect feedback and revise in two rounds.',
        milestones: [
          { title: 'First round shared', offsetDays: 3, clientVisible: true },
          { title: 'Final design approved', offsetDays: 10, clientVisible: true },
        ],
        workItems: [
          { title: 'Prepare the first round', offsetDays: 2 },
          { title: 'Apply the feedback', offsetDays: 8 },
        ],
        clientPortalOn: true,
      },
      {
        name: 'Brand asset library',
        description: 'Gather logos, colours and fonts in one place.',
        workItems: [
          { title: 'Collect the brand files', offsetDays: 0 },
          { title: 'Write the usage notes', offsetDays: 2 },
        ],
      },
    ],
    docs: ['Design feedback guide'],
    automations: ['Tell the client when a design is ready to review'],
  },
  {
    key: 'starter-developer',
    roles: ['developer'],
    language: 'en',
    workWeek: 'mon_fri',
    name: 'Developer starter',
    description: 'Feature delivery from spec to release, plus a weekly bug triage.',
    templates: [
      {
        name: 'Feature delivery',
        description: 'Spec, build, review and release one feature.',
        milestones: [
          { title: 'Spec agreed', offsetDays: 2 },
          { title: 'Released', offsetDays: 14 },
        ],
        workItems: [
          { title: 'Write the spec', offsetDays: 1 },
          { title: 'Build and test', offsetDays: 9 },
          { title: 'Code review', offsetDays: 11 },
        ],
      },
      {
        name: 'Bug triage',
        description: 'Sort new bugs every week and pick what to fix.',
        workItems: [
          { title: 'Sort new bug reports', offsetDays: 0 },
          { title: 'Pick the bugs for this week', offsetDays: 0 },
        ],
      },
    ],
    docs: ['Developer release checklist'],
    automations: ['Post released features in the project chat'],
  },
  {
    key: 'starter-marketing',
    roles: ['marketing'],
    language: 'en',
    workWeek: 'mon_fri',
    name: 'Marketing starter',
    description: 'A campaign launch and a monthly content calendar.',
    templates: [
      {
        name: 'Campaign launch',
        description: 'Brief, creative and launch for one campaign.',
        milestones: [
          { title: 'Brief approved', offsetDays: 2, clientVisible: true },
          { title: 'Campaign live', offsetDays: 21, clientVisible: true },
        ],
        workItems: [
          { title: 'Write the campaign brief', offsetDays: 1 },
          { title: 'Produce the creative', offsetDays: 14 },
          { title: 'Report the first week’s results', offsetDays: 28 },
        ],
        clientPortalOn: true,
      },
      {
        name: 'Monthly content calendar',
        description: 'Plan and publish a month of posts.',
        workItems: [
          { title: 'Plan the month’s posts', offsetDays: 0 },
          { title: 'Mid-month review', offsetDays: 14 },
        ],
        repeatInterval: 'monthly',
      },
    ],
    docs: ['Campaign brief'],
    automations: ['Remind the owner the day before a post is due'],
  },
  {
    key: 'starter-accounting',
    roles: ['accounting'],
    language: 'en',
    workWeek: 'mon_fri',
    name: 'Accounting starter',
    description: 'A monthly close and a client invoicing run.',
    templates: [
      {
        name: 'Month-end close',
        description: 'Close the books at the end of every month.',
        workItems: [
          { title: 'Reconcile the bank accounts', offsetDays: 0 },
          { title: 'Check logged time against invoices', offsetDays: 1 },
          { title: 'Send the month-end summary', offsetDays: 3 },
        ],
        repeatInterval: 'monthly',
      },
      {
        name: 'Client invoicing run',
        description: 'Prepare, check and send this period’s invoices.',
        workItems: [
          { title: 'Prepare the invoices', offsetDays: 0 },
          { title: 'Check them with the project leads', offsetDays: 1 },
          { title: 'Send the invoices', offsetDays: 2 },
        ],
      },
    ],
    docs: ['Invoicing checklist'],
    automations: ['Remind the client seven days after an invoice is due'],
  },
  // 54-23. Arabic agency packs: Arabic names and content, dates on a Sunday-to-Thursday week
  // (Saudi Arabia, Kuwait, Qatar, Oman, Bahrain and Egypt work Sunday to Thursday).
  {
    key: 'ar-agency-gulf',
    roles: ['agency_owner', 'project_manager', 'marketing'],
    language: 'ar',
    workWeek: 'sun_thu',
    name: 'حزمة وكالة الخليج',
    description: 'إطلاق عميل وحملة رمضان لوكالة في الخليج.',
    templates: [
      {
        name: 'إطلاق عميل جديد (الخليج)',
        description: 'الترحيب بالعميل والاتفاق على الملخص الإبداعي.',
        milestones: [
          { title: 'اجتماع الانطلاق', offsetDays: 0 },
          { title: 'اعتماد الملخص الإبداعي', offsetDays: 7, clientVisible: true },
        ],
        workItems: [
          { title: 'إرسال حزمة الترحيب', offsetDays: 0 },
          { title: 'جمع ملفات الهوية', offsetDays: 2 },
          { title: 'تجهيز عرض الانطلاق', offsetDays: 4 },
        ],
        clientPortalOn: true,
      },
      {
        name: 'حملة رمضان',
        description: 'تخطيط حملة رمضان وإنتاجها ونشرها مع مراعاة ساعات عمل رمضان.',
        milestones: [
          { title: 'اعتماد فكرة الحملة', offsetDays: 7, clientVisible: true },
          { title: 'إطلاق الحملة', offsetDays: 28, clientVisible: true },
        ],
        workItems: [
          { title: 'كتابة ملخص الحملة', offsetDays: 1 },
          { title: 'إنتاج المحتوى', offsetDays: 21 },
          { title: 'تقرير الأسبوع الأول', offsetDays: 35 },
        ],
        clientPortalOn: true,
      },
    ],
    docs: ['دليل استقبال العميل', 'الملخص الإبداعي'],
    automations: ['إبلاغ العميل عند اكتمال مرحلة'],
  },
  {
    key: 'ar-agency-egypt',
    roles: ['agency_owner', 'project_manager', 'designer'],
    language: 'ar',
    workWeek: 'sun_thu',
    name: 'حزمة وكالة مصر',
    description: 'إطلاق عميل وتجديد الهوية البصرية لوكالة في مصر.',
    templates: [
      {
        name: 'إطلاق عميل جديد (مصر)',
        description: 'الترحيب بالعميل والاتفاق على نطاق العمل.',
        milestones: [
          { title: 'اجتماع الانطلاق', offsetDays: 0 },
          { title: 'اعتماد نطاق العمل', offsetDays: 7, clientVisible: true },
        ],
        workItems: [
          { title: 'إرسال حزمة الترحيب', offsetDays: 0 },
          { title: 'حجز اجتماع الانطلاق', offsetDays: 1 },
          { title: 'جمع ملفات الهوية', offsetDays: 3 },
        ],
        clientPortalOn: true,
      },
      {
        name: 'تجديد الهوية البصرية',
        description: 'من لوحات الإلهام إلى هوية معتمدة في ثلاثة أسابيع.',
        milestones: [
          { title: 'مشاركة لوحات الإلهام', offsetDays: 4, clientVisible: true },
          { title: 'اعتماد الهوية', offsetDays: 21, clientVisible: true },
        ],
        workItems: [
          { title: 'دراسة السوق', offsetDays: 2 },
          { title: 'تجهيز ثلاث لوحات إلهام', offsetDays: 4 },
          { title: 'عرض الهوية المقترحة', offsetDays: 15 },
        ],
        clientPortalOn: true,
      },
    ],
    docs: ['الملخص الإبداعي', 'دليل استخدام الهوية'],
    automations: ['تذكير المسؤول قبل موعد التسليم بيومين'],
  },
];

export function findTemplatePack(key: string): TemplatePack | undefined {
  return TEMPLATE_PACKS.find((pack) => pack.key === key);
}

/** 55-02. The packs for a role, or every pack when no role is given. Catalog order is kept. */
export function templatePacksForRole(role: PackRole | null): readonly TemplatePack[] {
  return role === null
    ? TEMPLATE_PACKS
    : TEMPLATE_PACKS.filter((pack) => pack.roles.includes(role));
}

export function isPackRole(value: string): value is PackRole {
  return (PACK_ROLES as readonly string[]).includes(value);
}

/**
 * 54-23. Whether a day offset lands on a working day. Offsets count from the first working day of
 * the pack's week (Monday, or Sunday for a Sunday-to-Thursday week), so the five working days are
 * offsets 0-4 of every week.
 */
export function isWorkingDayOffset(offsetDays: number): boolean {
  return ((offsetDays % 7) + 7) % 7 <= 4;
}

const SETUP_LINES = {
  en: {
    docs: (pack: string, docs: string) => `Docs from the ${pack} pack: ${docs}.`,
    automations: (list: string) => `Suggested automations: ${list}.`,
    listSeparator: ', ',
    automationSeparator: '; ',
    workWeek: (week: PackWorkWeek) =>
      week === 'sun_thu' ? 'Work week: Sunday to Thursday.' : null,
  },
  ar: {
    docs: (pack: string, docs: string) => `مستندات ${pack}: ${docs}.`,
    automations: (list: string) => `أتمتة مقترحة: ${list}.`,
    listSeparator: '، ',
    automationSeparator: '؛ ',
    workWeek: (week: PackWorkWeek) =>
      week === 'sun_thu'
        ? 'أسبوع العمل: من الأحد إلى الخميس.'
        : 'أسبوع العمل: من الاثنين إلى الجمعة.',
  },
} as const;

/**
 * The template description with the pack's docs and automations appended as setup steps, written
 * in the pack's own language; a Sunday-to-Thursday pack also states its working week.
 */
export function packTemplateDescription(
  pack: TemplatePack,
  template: TemplatePackTemplate,
): string {
  const words = SETUP_LINES[pack.language];
  const lines = [template.description];
  if (pack.docs.length > 0) lines.push(words.docs(pack.name, pack.docs.join(words.listSeparator)));
  if (pack.automations.length > 0) {
    lines.push(words.automations(pack.automations.join(words.automationSeparator)));
  }
  const week = words.workWeek(pack.workWeek);
  if (week) lines.push(week);
  return lines.join('\n');
}
