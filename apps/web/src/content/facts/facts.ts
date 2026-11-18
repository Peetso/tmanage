import { RLM, type CompareLanguage } from '../compare/compare-entries';
import { HELLO_EMAIL } from '../../lib/public-contact';

/**
 * SEOF (backlog B7) — the facts page, `/facts` (Arabic at `/ar/facts`; Figma 687:15435 /
 * 687:15669, phone 687:15867 / 687:16043): one fixed description of TManage, the facts in one
 * table and what the product does today. Every line is true of the product today
 * (`social-media-plan/01-FACTS.md` section 3, LIVE rows): client invoices yes (Finance > Invoices,
 * live since A10b; INTEG14 corrected the facts file's "not built"), but clients cannot pay them
 * online; desktop app for Windows only, no phone app. Repo content, English and Arabic side by side.
 */

/** The day the facts page's words last changed (its "Last updated" line). */
export const FACTS_UPDATED_ON = '2026-11-19';

/** One row of the facts table; `link` rows show their value as a link. */
export interface FactRow {
  readonly label: string;
  readonly value: string;
  readonly link?: 'website' | 'email';
}

/**
 * The one fixed description of TManage (SEO/GEO plan 4.3), word for word on this page, in
 * `llms.txt` and wherever the site describes itself to machines (`TMANAGE_DESCRIPTION`).
 */
export const FACTS_DESCRIPTION = {
  en: 'TManage is a project and client-approvals workspace for companies and freelancers: chat, projects, files with client viewers, approvals, time tracking, client invoices and a client portal in one place, in English and Arabic.',
  ar: `${RLM}TManage مساحة عمل لإدارة المشاريع واعتماد العملاء، للشركات والمستقلين: المحادثة والمشاريع والملفات مع عارض للعملاء والاعتمادات وتسجيل الوقت وفواتير العملاء وبوابة العملاء في مكان واحد، بالعربية والإنجليزية.`,
} as const;
const DESCRIPTION = FACTS_DESCRIPTION;

export const FACTS_COPY = {
  en: {
    crumb: 'Facts',
    eyebrow: 'Facts',
    title: 'TManage facts',
    description: DESCRIPTION.en,
    tableEyebrow: 'At a glance',
    tableTitle: 'The facts in one table',
    rows: (website: string): FactRow[] => [
      {
        label: 'What it is',
        value: 'A project and client-approvals workspace for companies and freelancers',
      },
      { label: 'Category', value: 'Project management and client portal software' },
      {
        label: 'Who it is for',
        value: 'Companies of every kind, and freelancers, who deliver work to clients',
      },
      {
        label: 'Price today',
        value: 'Free during the beta: every feature, no card needed. Client users are always free.',
      },
      {
        label: 'After the beta',
        value: 'One flat price per team, never per seat. Clients never count.',
      },
      { label: 'Languages', value: 'English and Arabic, with full right-to-left layout' },
      { label: 'Platforms', value: 'Web browser, and a desktop app for Windows' },
      { label: 'Website', value: website, link: 'website' },
      { label: 'Contact', value: HELLO_EMAIL, link: 'email' },
    ],
    featuresEyebrow: 'Features',
    featuresTitle: 'What TManage does today',
    features: [
      'Projects, tasks, boards, lists and calendar',
      'Team chat with channels, direct messages and threads',
      'Turn any message into a task',
      'Client portal with requests, files and updates',
      'Approvals tied to the exact file version, in several steps',
      'File review with comments on images, PDF, video and audio',
      'Docs, meetings, decisions and risks',
      'Workload and capacity view',
      'Running timer for time tracking',
      'Client invoices and retainers, sent to the client and shown in the portal (no online payment yet)',
      'Files in your own Google Drive or OneDrive',
      'Your own Claude or ChatGPT through a connector, with no AI fee',
      'Roles, audit log and two-step sign-in on every plan',
    ],
    writersEyebrow: 'For writers',
    writersTitle: 'One description, word for word',
    writersLede: 'Use this sentence when you write about TManage.',
  },
  ar: {
    crumb: 'حقائق',
    eyebrow: 'حقائق',
    title: `حقائق عن ${RLM}TManage`,
    description: DESCRIPTION.ar,
    tableEyebrow: 'نظرة سريعة',
    tableTitle: 'الحقائق في جدول واحد',
    rows: (website: string): FactRow[] => [
      { label: 'ما هو', value: 'مساحة عمل لإدارة المشاريع واعتماد العملاء، للشركات والمستقلين' },
      { label: 'الفئة', value: 'برنامج لإدارة المشاريع وبوابة للعملاء' },
      {
        label: 'لمن',
        value: 'الشركات على اختلاف أنواعها، والمستقلون، ممن يسلّمون أعمالًا لعملائهم',
      },
      {
        label: 'السعر اليوم',
        value: 'مجاني طوال البيتا: كل المزايا، بدون بطاقة دفع. وحسابات العملاء مجانية دائمًا.',
      },
      {
        label: 'بعد البيتا',
        value: 'سعر ثابت واحد لكل فريق، وليس لكل مستخدم. ولا يُحتسب العملاء.',
      },
      { label: 'اللغات', value: 'العربية والإنجليزية، مع اتجاه كامل من اليمين لليسار' },
      { label: 'المنصات', value: `متصفح الويب، وتطبيق سطح مكتب على ${RLM}Windows` },
      { label: 'الموقع', value: website, link: 'website' },
      { label: 'التواصل', value: HELLO_EMAIL, link: 'email' },
    ],
    featuresEyebrow: 'المزايا',
    featuresTitle: `ما يقدّمه ${RLM}TManage اليوم`,
    features: [
      'المشاريع والمهام واللوحات والقوائم والتقويم',
      'محادثة الفريق بقنوات ورسائل مباشرة وسلاسل ردود',
      'حوّل أي رسالة إلى مهمة',
      'بوابة العملاء للطلبات والملفات والتحديثات',
      'اعتماد مرتبط بنسخة الملف نفسها، على عدة مراحل',
      `مراجعة الملفات بتعليقات على الصور و ${RLM}PDF والفيديو والصوت`,
      'المستندات والاجتماعات والقرارات والمخاطر',
      'عرض عبء العمل وسعة الفريق',
      'مؤقّت لتسجيل الوقت',
      'فواتير العملاء والعقود الشهرية، تُرسل إلى العميل وتظهر في بوابته (الدفع الإلكتروني غير متاح بعد)',
      `ملفاتك في ${RLM}Google Drive أو ${RLM}OneDrive الخاص بشركتك`,
      `استخدم ${RLM}Claude أو ${RLM}ChatGPT الخاص بك عبر موصّل، بدون رسوم ذكاء اصطناعي`,
      'الأدوار وسجل التدقيق والتحقق بخطوتين في كل الخطط',
    ],
    writersEyebrow: 'للكتّاب والصحفيين',
    writersTitle: 'وصف واحد بالنص نفسه',
    writersLede: `استخدم هذه الجملة عند الكتابة عن ${RLM}TManage.`,
  },
} satisfies Record<CompareLanguage, unknown>;

/** The English text of the facts page, for `llms-full.txt` and `/md/facts`. */
export function factsMarkdown(website: string): string[] {
  const copy = FACTS_COPY.en;
  return [
    copy.description,
    `## ${copy.tableTitle}`,
    copy
      .rows(website)
      .map((row) => `- **${row.label}:** ${row.value}`)
      .join('\n'),
    `## ${copy.featuresTitle}`,
    copy.features.map((feature) => `- ${feature}`).join('\n'),
  ];
}
