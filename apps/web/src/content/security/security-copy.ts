import type { CapsuleState } from '@tmanage/ui';

/**
 * Row 56-20 — the security page and trust centre (`/security`, `/ar/security`; Figma 613:34812 /
 * 613:35283, mobile 613:35096 / 613:35539), English and Arabic side by side (the compare pages'
 * repo-content pattern). Every "Live today" line is checked against the code in
 * `work/pass-2026-11-15d/SECPAGE-CLAIMS.md`; anything not provable today is "Planned". No
 * certification is claimed, the hosting region is not named here, and backups carry no frequency.
 * `{email}` marks where the report address is drawn as a link.
 */

export type SecurityLanguage = 'en' | 'ar';
export type ClaimStatus = 'live' | 'planned' | 'not_audited';

const RLM = '‏';

/** Status words and shapes: ✓ live, ○ planned, ■ not audited (the design's StateCapsule states). */
export const CLAIM_CAPSULE: Record<ClaimStatus, CapsuleState> = {
  live: 'done',
  planned: 'future',
  not_audited: 'neutral',
};

/** The progress table, in the design's order. */
export const SECURITY_CLAIMS: readonly { id: string; status: ClaimStatus }[] = [
  { id: 'https', status: 'live' },
  { id: 'isolation', status: 'live' },
  { id: 'activity', status: 'live' },
  { id: 'pentest', status: 'planned' },
  { id: 'restore', status: 'planned' },
  { id: 'soc2', status: 'not_audited' },
];

/** The eight cards; `id` doubles as the anchor the site links to (`/security#clients`). */
export const SECURITY_CARDS = [
  'location',
  'isolation',
  'encryption',
  'access',
  'clients',
  'ai',
  'backups',
  'report',
] as const;
export type SecurityCard = (typeof SECURITY_CARDS)[number];

export const SECURITY_COPY = {
  en: {
    eyebrow: 'Security',
    title: 'How we keep your work safe',
    lede: 'Plain answers: where your data lives, who can see it, how it is protected, and what to do if something goes wrong.',
    meta: 'Last reviewed 15 Nov 2026 · We only list what is true today.',
    cards: {
      location: {
        title: 'Where your data lives',
        body: 'Your workspace is stored with our hosting provider, Hostinger. The region is named on the sub-processors page.',
      },
      isolation: {
        title: 'Each workspace kept apart',
        body: 'Every request is checked against the workspace it belongs to. Automated tests check this.',
      },
      encryption: {
        title: 'Encryption',
        body: 'Every connection uses HTTPS. Keys for the apps you connect are stored encrypted.',
      },
      access: {
        title: 'Access and history',
        body: 'Owners decide who sees what. Important changes go into an activity log you can review.',
      },
      clients: {
        title: 'Files',
        body: 'Clients see only what you share with them. Shared links can expire.',
      },
      ai: {
        title: 'AI',
        body: "We don't train AI on your work. AI tools work only when you connect them, and only with your permission.",
      },
      backups: {
        title: 'Backups',
        body: 'We keep regular backups of your data. A timed restore test is next on our list.',
      },
      report: {
        title: 'Report a problem',
        body: 'Write to {email}. A person on our team reads every report.',
      },
    } satisfies Record<SecurityCard, { title: string; body: string }>,
    todayTitle: 'Where we are today',
    todayNote:
      '"Live today" means it works now. "Planned" means we are working on it. It is not a promise yet.',
    status: { live: 'Live today', planned: 'Planned', not_audited: 'Not audited' },
    claims: {
      https: 'HTTPS on every page and connection',
      isolation: 'Separate workspaces, checked by tests',
      activity: 'Activity log for important changes',
      pentest: 'Independent penetration test',
      restore: 'Timed restore test',
      soc2: 'SOC 2: we follow its controls, but we are not audited or certified',
    } as Record<string, string>,
    subsTitle: 'Sub-processors',
    subsBody: 'The companies that help us run TManage, what each one does and where.',
    subsAction: 'See the list',
    reviewTitle: 'Doing a security review?',
    reviewBody: 'Send us your questions and we will answer them in plain words.',
    reviewAction: 'Ask a question',
    ctaTitle: 'Found a security problem?',
    ctaBody: "E-mail {email}. Please don't send passwords or client files.",
    ctaAction: 'E-mail us',
    ctaLink: 'or read how we handle reports →',
  },
  ar: {
    eyebrow: 'الأمان',
    title: 'كيف نحمي عملك',
    lede: 'إجابات واضحة: أين تُحفظ بياناتك، ومن يمكنه رؤيتها، وكيف نحميها، وماذا تفعل إذا حدث خطأ.',
    meta: 'آخر مراجعة 15 نوفمبر 2026 · نذكر فقط ما هو صحيح اليوم.',
    cards: {
      location: {
        title: 'أين تُحفظ بياناتك',
        body: 'تُحفظ مساحة عملك لدى مزوّد الاستضافة Hostinger، والمنطقة مذكورة في صفحة المعالِجين الفرعيين.',
      },
      isolation: {
        title: 'كل مساحة عمل منفصلة',
        body: 'نتحقق من كل طلب مقابل مساحة العمل التابع لها، وتتحقق من ذلك اختبارات آلية.',
      },
      encryption: {
        title: 'التشفير',
        body: 'كل الاتصالات عبر HTTPS، ومفاتيح التطبيقات التي تربطها محفوظة مشفّرة.',
      },
      access: {
        title: 'الصلاحيات والسجل',
        body: 'يحدّد المالك من يرى ماذا، وتُسجَّل التغييرات المهمة في سجل نشاط يمكنك مراجعته.',
      },
      clients: {
        title: 'الملفات',
        body: 'يرى العملاء ما تشاركه معهم فقط، ويمكن أن تنتهي صلاحية الروابط المشتركة.',
      },
      ai: {
        title: 'الذكاء الاصطناعي',
        body: 'لا ندرّب أي ذكاء اصطناعي على عملك. تعمل أدوات الذكاء الاصطناعي فقط عندما تربطها وبإذنك.',
      },
      backups: {
        title: 'النسخ الاحتياطية',
        body: 'نحتفظ بنسخ احتياطية منتظمة لبياناتك، واختبار الاستعادة المؤقّت هو التالي في خطتنا.',
      },
      report: {
        title: 'الإبلاغ عن مشكلة',
        body: 'راسلنا على {email}، ويقرأ كل بلاغ شخص من فريقنا.',
      },
    } satisfies Record<SecurityCard, { title: string; body: string }>,
    todayTitle: 'أين نحن اليوم',
    todayNote: '«متاح اليوم» يعني أنه يعمل الآن. «مخطّط» يعني أننا نعمل عليه، وليس وعداً بعد.',
    status: { live: 'متاح اليوم', planned: 'مخطّط', not_audited: 'غير مُدقَّق' },
    claims: {
      https: `${RLM}HTTPS في كل صفحة وكل اتصال`,
      isolation: 'مساحات عمل منفصلة تتحقق منها الاختبارات',
      activity: 'سجل نشاط للتغييرات المهمة',
      pentest: 'اختبار اختراق مستقل',
      restore: 'اختبار استعادة مؤقّت',
      soc2: 'نتّبع ضوابط SOC 2، لكننا غير مُدقَّقين ولا حاصلين على شهادة',
    } as Record<string, string>,
    subsTitle: 'المعالِجون الفرعيون',
    subsBody: 'الشركات التي تساعدنا في تشغيل TManage، وما يفعله كل منها وأين.',
    subsAction: 'اطّلع على القائمة',
    reviewTitle: 'تُجري مراجعة أمنية؟',
    reviewBody: 'أرسل إلينا أسئلتك وسنجيب عنها بكلمات واضحة.',
    reviewAction: 'اطرح سؤالاً',
    ctaTitle: 'وجدت مشكلة أمنية؟',
    ctaBody: 'راسلنا على {email}. لا ترسل كلمات مرور أو ملفات عملاء.',
    ctaAction: 'راسلنا',
    ctaLink: 'أو اقرأ كيف نتعامل مع البلاغات ←',
  },
} as const;

export function securityCopy(language: SecurityLanguage) {
  return SECURITY_COPY[language];
}
