import { IMPORT_SOURCES, type ImportSourceId } from '../../lib/import-sources';
import { RLM, type Bilingual, type CompareLanguage } from './compare-entries';

/**
 * Row 54-29 — the "switch from X" pages (`/switch/<slug>`, Arabic at `/ar/switch/<slug>`), on the
 * compare pages' template and content model (57-06).
 *
 * Every line here is about the reader or about TManage today: nothing is said about the other
 * product (no price, plan, feature or limit). What comes over is read from the importer itself:
 * each table row names the importer field ({@link IMPORT_SOURCES}) that carries it, and the test
 * fails when the importer stops reading that field. Basecamp's archive has no column mapping, so
 * its rows name what `readBasecampArchive` and the API's Basecamp commit do with it. Arabic is
 * Modern Standard Arabic; product names stay in Latin script, followed by U+200F where Arabic
 * continues after them.
 */

export interface SwitchRow {
  /** The importer field this row stands for, or `archive` for the Basecamp ZIP reader. */
  readonly field: string;
  readonly from: Bilingual;
  readonly to: Bilingual;
}

export interface SwitchEntry {
  readonly slug: string;
  /** The product name, in Latin script in both languages (also in `SWITCH_LINKS`). */
  readonly name: string;
  /** The import source the page leads to. */
  readonly source: ImportSourceId;
  /** Three situations a reader may recognise; never a claim about the other product. */
  readonly situations: Readonly<Record<CompareLanguage, readonly [string, string, string]>>;
  /** How the move works in TManage, step by step. */
  readonly how: Bilingual;
  readonly rows: readonly SwitchRow[];
}

const row = (field: string, from: Bilingual, to: Bilingual): SwitchRow => ({ field, from, to });

const WORK_ITEMS = { en: 'Work items', ar: 'عناصر عمل' };
const STATUS = row(
  'status',
  { en: 'Statuses', ar: 'الحالات' },
  { en: 'Work states, matched by name', ar: 'حالات العمل، مطابَقة بالاسم' },
);
const OWNERS = {
  en: 'Owners, matched to members of your team. Anyone not matched comes over unassigned',
  ar: 'المسؤولون، مطابَقون مع أعضاء فريقك. ومن لا يُطابَق يأتي عمله بلا مسؤول',
};
const DUE = { en: 'Due dates', ar: 'تواريخ الاستحقاق' };
const START_DUE = { en: 'Start and due dates', ar: 'تواريخ البدء والاستحقاق' };
const TAGS = row(
  'tags',
  { en: 'Tags and labels', ar: 'الوسوم والتصنيفات' },
  { en: 'Labels', ar: 'تصنيفات' },
);
const PRIORITY = row(
  'priority',
  { en: 'Priority', ar: 'الأولوية' },
  { en: 'Priority', ar: 'الأولوية' },
);
const DESCRIPTION = (from: Bilingual) =>
  row('description', from, { en: 'The work item’s description', ar: 'وصف عنصر العمل' });
const SUBTASKS = row(
  'parent',
  { en: 'Sub-items and subtasks', ar: 'العناصر والمهام الفرعية' },
  { en: 'Subtasks of their work item', ar: 'مهام فرعية تحت عنصر العمل' },
);
const COMMENTS = row(
  'comments',
  { en: 'Comments and updates', ar: 'التعليقات والتحديثات' },
  { en: 'Comments on the work item', ar: 'تعليقات على عنصر العمل' },
);

const UNDO_AND_LIMITS = {
  en: 'Every row is checked before anything is saved, and one file holds up to 1,000 rows.',
  ar: 'يُفحص كل صف قبل حفظ أي شيء، ويتّسع الملف الواحد لـ 1,000 صف.',
};

export const SWITCH_ENTRIES: readonly SwitchEntry[] = [
  {
    slug: 'monday',
    name: 'monday.com',
    source: 'monday',
    situations: {
      en: [
        'Your boards now hold client projects, and clients keep asking where things stand',
        'Client approvals happen in e-mail and are hard to find later',
        'Your team works in Arabic and English',
      ],
      ar: [
        'صارت لوحاتك تضم مشاريع العملاء، والعملاء يسألون دائمًا أين وصل العمل',
        'تتم موافقات العملاء عبر البريد ويصعب العثور عليها لاحقًا',
        'يعمل فريقك بالعربية والإنجليزية',
      ],
    },
    how: {
      en: `TManage’s importer reads a monday.com board exported to Excel (.xlsx). On the Import page, choose monday.com, pick the project the work goes into and check how the columns match. ${UNDO_AND_LIMITS.en}`,
      ar: `يقرأ مستورد TManage${RLM} لوحة من monday.com${RLM} مصدَّرة بصيغة Excel${RLM} (.xlsx). في صفحة الاستيراد اختر monday.com${RLM}، ثم المشروع الذي ينتقل إليه العمل، وراجع مطابقة الأعمدة. ${UNDO_AND_LIMITS.ar}`,
    },
    rows: [
      row('name', { en: 'Items', ar: 'العناصر' }, WORK_ITEMS),
      row(
        'group',
        { en: 'Groups', ar: 'المجموعات' },
        { en: 'Labels, so items stay grouped', ar: 'تصنيفات، فتبقى العناصر مجمّعة' },
      ),
      STATUS,
      row('person', { en: 'People', ar: 'الأشخاص' }, OWNERS),
      row('date', { en: 'Dates and timelines', ar: 'التواريخ والجداول الزمنية' }, START_DUE),
      TAGS,
      PRIORITY,
      DESCRIPTION({ en: 'Text and notes', ar: 'النصوص والملاحظات' }),
      SUBTASKS,
      COMMENTS,
    ],
  },
  {
    slug: 'asana',
    name: 'Asana',
    source: 'asana',
    situations: {
      en: [
        'You plan client work in projects and want clients to approve it in the same place',
        'Time and invoices sit in other tools, away from the tasks',
        'Your team or your clients read Arabic',
      ],
      ar: [
        'تخطّط عمل العملاء في مشاريع وتريد أن يعتمده العملاء في المكان نفسه',
        'الوقت والفواتير في أدوات أخرى بعيدًا عن المهام',
        'فريقك أو عملاؤك يقرؤون العربية',
      ],
    },
    how: {
      en: `TManage’s importer reads an Asana project exported to CSV. On the Import page, choose Asana, pick the project the work goes into and check how the columns match. ${UNDO_AND_LIMITS.en} You can also connect with your own Asana personal access token and bring tasks over with their comments; running it again skips tasks already imported.`,
      ar: `يقرأ مستورد TManage${RLM} مشروعًا من Asana${RLM} مصدَّرًا بصيغة CSV${RLM}. في صفحة الاستيراد اختر Asana${RLM}، ثم المشروع الذي ينتقل إليه العمل، وراجع مطابقة الأعمدة. ${UNDO_AND_LIMITS.ar} ويمكنك أيضًا الاتصال برمز الوصول الشخصي الخاص بك في Asana${RLM} ونقل المهام مع تعليقاتها، وإذا أعدت التشغيل تُتخطّى المهام المستوردة من قبل.`,
    },
    rows: [
      row('name', { en: 'Tasks', ar: 'المهام' }, WORK_ITEMS),
      row(
        'status',
        { en: 'Sections', ar: 'الأقسام' },
        { en: 'Work states, matched by name', ar: 'حالات العمل، مطابَقة بالاسم' },
      ),
      row('person', { en: 'Assignees', ar: 'المكلَّفون' }, OWNERS),
      row('date', DUE, DUE),
      TAGS,
      DESCRIPTION({ en: 'Notes', ar: 'الملاحظات' }),
    ],
  },
  {
    slug: 'clickup',
    name: 'ClickUp',
    source: 'clickup',
    situations: {
      en: [
        'You want one place where clients review and approve your work',
        'You bill clients for time and want invoices beside the work',
        'Your clients read Arabic and expect the screen to run right to left',
      ],
      ar: [
        'تريد مكانًا واحدًا يراجع فيه العملاء عملك ويعتمدونه',
        'تحاسب العملاء على الوقت وتريد الفواتير بجانب العمل',
        'عملاؤك يقرؤون العربية وينتظرون شاشة من اليمين إلى اليسار',
      ],
    },
    how: {
      en: `TManage’s importer reads a ClickUp task export in CSV. On the Import page, choose ClickUp, pick the project the work goes into and check how the columns match. ${UNDO_AND_LIMITS.en}`,
      ar: `يقرأ مستورد TManage${RLM} ملف CSV${RLM} بمهام مصدَّرة من ClickUp${RLM}. في صفحة الاستيراد اختر ClickUp${RLM}، ثم المشروع الذي ينتقل إليه العمل، وراجع مطابقة الأعمدة. ${UNDO_AND_LIMITS.ar}`,
    },
    rows: [
      row('name', { en: 'Tasks', ar: 'المهام' }, WORK_ITEMS),
      row(
        'group',
        { en: 'Lists', ar: 'القوائم' },
        { en: 'Labels, so tasks stay grouped', ar: 'تصنيفات، فتبقى المهام مجمّعة' },
      ),
      STATUS,
      row('person', { en: 'Assignees', ar: 'المكلَّفون' }, OWNERS),
      row('dueDate', { en: 'Start and due dates', ar: 'تواريخ البدء والاستحقاق' }, START_DUE),
      TAGS,
      PRIORITY,
      DESCRIPTION({ en: 'Task content', ar: 'محتوى المهمة' }),
      SUBTASKS,
      COMMENTS,
    ],
  },
  {
    slug: 'trello',
    name: 'Trello',
    source: 'trello',
    situations: {
      en: [
        'Your boards grew into client projects with owners and deadlines',
        'Client feedback arrives by e-mail and chat, and some of it gets lost',
        'You need to track time and send invoices for the same work',
      ],
      ar: [
        'كبرت لوحاتك حتى صارت مشاريع عملاء لها مسؤولون ومواعيد',
        'تصل ملاحظات العملاء عبر البريد والمحادثات، ويضيع بعضها',
        'تحتاج إلى تتبّع الوقت وإصدار الفواتير للعمل نفسه',
      ],
    },
    how: {
      en: `TManage’s importer reads a Trello board exported to CSV. On the Import page, choose Trello, pick the project the work goes into and check how the columns match. ${UNDO_AND_LIMITS.en} You can also connect with your own Trello API key and token and bring cards over with their comments; running it again skips cards already imported.`,
      ar: `يقرأ مستورد TManage${RLM} لوحة من Trello${RLM} مصدَّرة بصيغة CSV${RLM}. في صفحة الاستيراد اختر Trello${RLM}، ثم المشروع الذي ينتقل إليه العمل، وراجع مطابقة الأعمدة. ${UNDO_AND_LIMITS.ar} ويمكنك أيضًا الاتصال بمفتاح API${RLM} والرمز الخاصين بك في Trello${RLM} ونقل البطاقات مع تعليقاتها، وإذا أعدت التشغيل تُتخطّى البطاقات المستوردة من قبل.`,
    },
    rows: [
      row('name', { en: 'Cards', ar: 'البطاقات' }, WORK_ITEMS),
      row(
        'status',
        { en: 'Lists', ar: 'القوائم' },
        { en: 'Work states, matched by name', ar: 'حالات العمل، مطابَقة بالاسم' },
      ),
      row('person', { en: 'Members', ar: 'الأعضاء' }, OWNERS),
      row('date', DUE, DUE),
      TAGS,
      DESCRIPTION({ en: 'Card descriptions', ar: 'أوصاف البطاقات' }),
    ],
  },
  {
    slug: 'basecamp',
    name: 'Basecamp',
    source: 'basecamp',
    situations: {
      en: [
        'You want clients to approve work and keep a record of each approval',
        'You want time tracking and invoices beside your projects',
        'Your team works in Arabic and English',
      ],
      ar: [
        'تريد أن يعتمد العملاء العمل وأن تحتفظ بسجل لكل اعتماد',
        'تريد تتبّع الوقت والفواتير بجانب مشاريعك',
        'يعمل فريقك بالعربية والإنجليزية',
      ],
    },
    how: {
      en: `TManage’s importer reads a Basecamp project archive (a ZIP file) in your browser. On the Import page, choose Basecamp and pick the project the pages go into. Every page is checked before anything is saved, and one archive brings up to 1,000 pages.`,
      ar: `يقرأ مستورد TManage${RLM} أرشيف مشروع من Basecamp${RLM} (ملف ZIP${RLM}) داخل متصفحك. في صفحة الاستيراد اختر Basecamp${RLM}، ثم المشروع الذي تنتقل إليه الصفحات. تُفحص كل صفحة قبل حفظ أي شيء، ويحمل الأرشيف الواحد حتى 1,000 صفحة.`,
    },
    rows: [
      row(
        'archive',
        { en: 'Pages of the archive', ar: 'صفحات الأرشيف' },
        { en: 'Documents in the project', ar: 'مستندات داخل المشروع' },
      ),
      row(
        'archive',
        { en: 'Comments on messages', ar: 'التعليقات على الرسائل' },
        {
          en: 'Kept inside the document, with author and time',
          ar: 'محفوظة داخل المستند، مع الكاتب والوقت',
        },
      ),
    ],
  },
  {
    slug: 'jira',
    name: 'Jira',
    source: 'jira',
    situations: {
      en: [
        'Your team delivers projects for clients, not only releases',
        'Clients need to follow progress and approve work in a portal of their own',
        'You track time and bill clients for it',
      ],
      ar: [
        'يسلّم فريقك مشاريع للعملاء، لا إصدارات فقط',
        'يحتاج العملاء إلى متابعة التقدّم واعتماد العمل في بوابة خاصة بهم',
        'تتتبّع الوقت وتحاسب العملاء عليه',
      ],
    },
    how: {
      en: `TManage’s importer reads a Jira issue export in CSV, one Jira project per file. On the Import page, choose Jira, pick the project the issues go into and check how the columns match. ${UNDO_AND_LIMITS.en}`,
      ar: `يقرأ مستورد TManage${RLM} ملف CSV${RLM} بمسائل مصدَّرة من Jira${RLM}، مشروعًا واحدًا في كل ملف. في صفحة الاستيراد اختر Jira${RLM}، ثم المشروع الذي تنتقل إليه المسائل، وراجع مطابقة الأعمدة. ${UNDO_AND_LIMITS.ar}`,
    },
    rows: [
      row(
        'issueKey',
        { en: 'Issues and their keys', ar: 'المسائل ومفاتيحها' },
        {
          en: 'Work items that keep their keys (WEB-42 stays WEB-42)',
          ar: 'عناصر عمل تحتفظ بمفاتيحها (WEB-42 يبقى WEB-42)',
        },
      ),
      row(
        'parent',
        { en: 'Epics', ar: 'الملاحم (Epics)' },
        { en: 'A label on each of their issues', ar: 'تصنيف على كل مسألة تابعة لها' },
      ),
      STATUS,
      row('assigneeEmail', { en: 'Assignees', ar: 'المكلَّفون' }, OWNERS),
      row('sprint', { en: 'Sprints', ar: 'السبرنتات' }, { en: 'Iterations', ar: 'دورات العمل' }),
      row('dueDate', DUE, DUE),
      PRIORITY,
      DESCRIPTION({ en: 'Descriptions', ar: 'الأوصاف' }),
    ],
  },
];

export function findSwitchEntry(slug: string): SwitchEntry | undefined {
  return SWITCH_ENTRIES.find((entry) => entry.slug === slug);
}

/** `/switch/<slug>`, or its Arabic twin under `/ar`. */
export function switchHref(slug: string, language: CompareLanguage): string {
  const path = `/switch/${slug}`;
  return language === 'ar' ? `/ar${path}` : path;
}

/** The importer fields the source reads (empty for the Basecamp archive, which has none). */
export function importerFields(entry: SwitchEntry): readonly string[] {
  return IMPORT_SOURCES[entry.source].fields.map((field) => field.target);
}
