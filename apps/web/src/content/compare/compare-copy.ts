import { RLM, type CompareFeature, type CompareLanguage } from './compare-entries';

/**
 * Row 57-06 — the compare pages' own interface words, English and Arabic side by side (the Help
 * centre's repo-content pattern). Names arrive in Latin script; Arabic lines that start with one
 * are prefixed with U+200F.
 */

const EN_MONTHS = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const AR_MONTHS = new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const dateOf = (iso: string) => new Date(`${iso}T00:00:00Z`);

export const COMPARE_COPY = {
  en: {
    eyebrow: 'Compare',
    indexTitle: 'TManage compared',
    indexLede:
      'Honest side-by-sides for agencies choosing a tool to run client work. Each page says where the other tool is strong, too.',
    cardHint: (date: string) => `Last checked ${date}`,
    title: (name: string) => `TManage vs ${name}`,
    lede: 'An honest side-by-side for agencies choosing a tool to run client work. We say where each one fits.',
    lastChecked: (date: string) => `Last checked ${date}`,
    spotMistake: 'Spot a mistake? Tell us',
    stale: 'These facts were checked more than 90 days ago and may be out of date.',
    suitsThem: (name: string) => `${name} may suit you if…`,
    suitsUs: 'TManage may suit you if…',
    usSuits: [
      'Clients approve your work and you want a record of it',
      'You work in Arabic and English',
      'You want tasks, time and invoices in one place',
    ],
    sideBySide: 'Side by side',
    need: 'What you need',
    features: {
      tasks: 'Projects and tasks',
      clients: 'Clients or guests in the work',
      time: 'Time tracking',
      invoices: 'Invoices to clients',
      arabic: 'Arabic interface, right to left',
      files: 'Where your files live',
    } satisfies Record<CompareFeature, string>,
    price: 'Price',
    seePricing: (name: string) => `See ${name}’s pricing page`,
    checkedNote: (name: string, date: string) =>
      `We checked ${name}’s public website on ${date} and list only what we could confirm there. Products change. If something here is out of date, write to`,
    fixIt: 'and we will fix it.',
    trademark: (name: string) =>
      `${name} is a trademark of its owner. TManage is not affiliated with it.`,
    strongTitle: (name: string) => `Where ${name} is strong`,
    differentTitle: 'Where TManage is different',
    different:
      'Built for agencies and their clients: approvals sealed in a record with a certificate, a client portal in Arabic and English, and time and invoices beside the work.',
    movingTitle: 'Moving over',
    moving:
      'Start free during the beta and invite clients at no cost. Your files can stay in your own Google Drive or OneDrive.',
    ctaTitle: 'See it with your own projects',
    ctaLede: 'Free during the beta · No card needed · Client users always free',
    ctaPrimary: 'Start free',
    ctaSecondary: 'or book a demo',
    allCompare: 'All comparisons',
    date: (iso: string) => EN_MONTHS.format(dateOf(iso)),
  },
  ar: {
    eyebrow: 'مقارنة',
    indexTitle: `${RLM}TManage مقارنةً بغيره`,
    indexLede:
      'مقارنات صادقة للوكالات التي تختار أداة لإدارة عمل العملاء. وكل صفحة تذكر أيضًا نقاط قوة الأداة الأخرى.',
    cardHint: (date: string) => `آخر مراجعة ${date}`,
    title: (name: string) => `${RLM}TManage مقابل ${name}`,
    lede: 'مقارنة صادقة للوكالات التي تختار أداة لإدارة عمل العملاء. نوضّح أين تناسب كل أداة.',
    lastChecked: (date: string) => `آخر مراجعة ${date}`,
    spotMistake: 'وجدت خطأ؟ أخبرنا',
    stale: 'رُوجعت هذه المعلومات قبل أكثر من 90 يومًا وقد لا تكون محدّثة.',
    suitsThem: (name: string) => `قد يناسبك ${name}${RLM} إذا…`,
    suitsUs: `قد يناسبك TManage${RLM} إذا…`,
    usSuits: [
      'كان عملاؤك يعتمدون عملك وتريد سجلًا بذلك',
      'كنت تعمل بالعربية والإنجليزية',
      'أردت المهام والوقت والفواتير في مكان واحد',
    ],
    sideBySide: 'جنبًا إلى جنب',
    need: 'ما تحتاجه',
    features: {
      tasks: 'المشاريع والمهام',
      clients: 'العملاء أو الضيوف داخل العمل',
      time: 'تتبّع الوقت',
      invoices: 'فواتير العملاء',
      arabic: 'واجهة عربية من اليمين إلى اليسار',
      files: 'أين تُحفظ ملفاتك',
    } satisfies Record<CompareFeature, string>,
    price: 'السعر',
    seePricing: (name: string) => `راجع صفحة أسعار ${name}${RLM}`,
    checkedNote: (name: string, date: string) =>
      `راجعنا موقع ${name}${RLM} العام في ${date}، ولا نذكر إلا ما تأكدنا منه هناك. المنتجات تتغيّر، فإذا وجدت معلومة قديمة راسلنا على`,
    fixIt: 'وسنصحّحها.',
    trademark: (name: string) => `${name}${RLM} علامة تجارية لمالكها، ولا يرتبط TManage${RLM} بها.`,
    strongTitle: (name: string) => `نقاط قوة ${name}${RLM}`,
    differentTitle: `بماذا يختلف TManage${RLM}`,
    different:
      'صُمّم للوكالات وعملائها: اعتمادات محفوظة في سجل مختوم مع شهادة، وبوابة عملاء بالعربية والإنجليزية، والوقت والفواتير بجانب العمل.',
    movingTitle: 'الانتقال',
    moving:
      'ابدأ مجانًا خلال الفترة التجريبية وادعُ عملاءك دون تكلفة. ويمكن أن تبقى ملفاتك في Google Drive أو OneDrive الخاص بك.',
    ctaTitle: 'جرّبه على مشاريعك',
    ctaLede: 'مجاني خلال الفترة التجريبية · بلا بطاقة · مستخدمو العملاء مجانيون دائمًا',
    ctaPrimary: 'ابدأ مجانًا',
    ctaSecondary: 'أو احجز عرضًا توضيحيًا',
    allCompare: 'كل المقارنات',
    date: (iso: string) => AR_MONTHS.format(dateOf(iso)),
  },
} satisfies Record<CompareLanguage, unknown>;

/**
 * Row 54-29 — the "switch from X" pages' own words, on the compare template. They speak about the
 * reader and about TManage today, never about the other product.
 */
export const SWITCH_COPY = {
  en: {
    eyebrow: 'Switch',
    title: (name: string) => `Switching from ${name} to TManage`,
    description: (name: string) =>
      `What TManage brings over from ${name}, how the import works, and how to undo it.`,
    lede: 'What TManage brings over from your export, and what to check before you start.',
    situationsTitle: 'It may be time to move if…',
    carriesTitle: 'What comes over',
    from: (name: string) => `From ${name}`,
    into: 'In TManage',
    howTitle: 'How the move works',
    undoTitle: 'Changed your mind?',
    undo: 'Any import can be undone in one click for 7 days. Work whose owner does not match a member of your team comes over unassigned, so you can assign it afterwards.',
    filesTitle: 'Files and attachments',
    files:
      'Attachments are not copied over. Your files can stay in your own Google Drive or OneDrive.',
    compareLink: (name: string) => `TManage vs ${name}`,
    helpLink: (name: string) => `How to export your work from ${name}, step by step`,
  },
  ar: {
    eyebrow: 'الانتقال',
    title: (name: string) => `الانتقال من ${name}${RLM} إلى TManage${RLM}`,
    description: (name: string) =>
      `ما ينقله TManage${RLM} من ${name}${RLM}، وكيف يعمل الاستيراد، وكيف تتراجع عنه.`,
    lede: 'ما ينقله TManage من ملف التصدير، وما تتحقّق منه قبل أن تبدأ.',
    situationsTitle: 'ربما حان وقت الانتقال إذا…',
    carriesTitle: 'ما الذي ينتقل',
    from: (name: string) => `من ${name}${RLM}`,
    into: `في TManage${RLM}`,
    howTitle: 'كيف يتم الانتقال',
    undoTitle: 'غيّرت رأيك؟',
    undo: 'يمكنك التراجع عن أي استيراد بنقرة واحدة خلال 7 أيام. والعمل الذي لا يطابق مسؤوله أحدًا من أعضاء فريقك يأتي بلا مسؤول، فتسنده لاحقًا.',
    filesTitle: 'الملفات والمرفقات',
    files: 'لا تُنسخ المرفقات. ويمكن أن تبقى ملفاتك في Google Drive أو OneDrive الخاص بك.',
    compareLink: (name: string) => `${RLM}TManage مقابل ${name}`,
    helpLink: (name: string) => `كيف تصدّر عملك من ${name}${RLM}، خطوة بخطوة`,
  },
} satisfies Record<CompareLanguage, unknown>;

export type CompareCopy = (typeof COMPARE_COPY)['en'];

export function compareCopy(language: CompareLanguage): CompareCopy {
  return COMPARE_COPY[language];
}
