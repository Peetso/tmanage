import { RLM, type CompareLanguage } from '../compare/compare-entries';
import type { AlternativeFit } from './alternative-entries';

/**
 * SEOF (B1) — the alternative pages' own words, English and Arabic side by side (the compare
 * pages' repo-content pattern; Figma 685:13383, strings in FIGMAALT-REPORT.md). They speak about
 * the reader and about TManage today; the other product appears by name only, and its facts come
 * from its compare entry. In Arabic a Latin product name is preceded by U+200F.
 */

const EN_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const AR_DATE = new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const dateOf = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** The rows of an alternative page's table, in display order (`strong` is always last). */
export type AlternativeRow =
  'pricing' | 'tasks' | 'clients' | 'time' | 'invoices' | 'arabic' | 'files' | 'strong';

/** The words both the hero of every alternative page and the facts page use. */
export const PUBLIC_HERO_COPY = {
  en: {
    home: 'Home',
    crumbLabel: 'Breadcrumb',
    startFree: 'Start free',
    micro: 'Free during the beta · No card needed · Client users always free',
    updated: (date: string) => `Last updated ${date}`,
    date: (iso: string) => EN_DATE.format(dateOf(iso)),
  },
  ar: {
    home: 'الرئيسية',
    crumbLabel: 'مسار التنقل',
    startFree: 'ابدأ مجانًا',
    micro: 'مجاني طوال البيتا · بدون بطاقة دفع · حسابات العملاء مجانية دائمًا',
    updated: (date: string) => `آخر تحديث: ${date}`,
    date: (iso: string) => AR_DATE.format(dateOf(iso)),
  },
} satisfies Record<CompareLanguage, unknown>;

export const ALTERNATIVE_COPY = {
  en: {
    alternatives: 'Alternatives',
    eyebrow: (name: string) => `${name} alternative`,
    title: (name: string) => `A ${name} alternative for agencies`,
    tabTitle: (name: string) => `${name} alternative for agencies`,
    description: (name: string) =>
      `TManage is a ${name} alternative for agencies that need client approvals, a client portal and one flat team price.`,
    lede: (name: string) =>
      `TManage is a ${name} alternative for agencies that need client approvals, a client portal and one flat team price. It is free during the beta and works fully in Arabic and English.`,
    compareButton: 'Compare side by side',
    whyEyebrow: 'Why teams look',
    whyTitle: (name: string) => `Why teams look for a ${name} alternative`,
    reasons: (name: string, fit: AlternativeFit) => [
      fit.theyHaveArabic
        ? {
            title: 'Each person picks a language',
            body: `Like ${name}, TManage works in Arabic, right to left. Each person picks Arabic or English for their own screens.`,
          }
        : {
            title: 'Your team works in Arabic',
            body: 'In TManage every screen works in Arabic, right to left, and in English. Each person picks their own language.',
          },
      {
        title: 'Clients need to sign off',
        body: fit.theyListClients
          ? `The table below shows how ${name} lets clients in. TManage adds approvals tied to the exact version.`
          : 'In TManage clients work in their own portal and approve the exact version. Client users are always free.',
      },
      {
        title: 'The team keeps growing',
        body: `After the beta, TManage charges one flat price per team, and clients never count. Compare it with ${name}’s pricing page.`,
      },
    ],
    tableEyebrow: 'Side by side',
    tableTitle: (name: string) => `TManage and ${name}, side by side`,
    tableLede: (name: string) =>
      `Plain facts, checked by hand. Where ${name} is ahead, the table says so.`,
    need: 'What you compare',
    rows: {
      pricing: 'Pricing',
      tasks: 'Tasks',
      clients: 'Client access',
      time: 'Time tracking',
      arabic: 'Arabic interface',
      invoices: 'Invoices',
      files: 'Files',
    },
    strongRow: (name: string) => `Where ${name} is strong`,
    ours: {
      pricing: 'Free during the beta; then one flat price per team, and clients never count',
      tasks: 'Projects, tasks, boards, lists and calendar',
      clients: 'Client portal; clients approve the exact version',
      time: 'Running timer for time tracking',
      invoices: 'Yes, invoices and quotes (no online payment yet)',
      arabic: 'Yes, fully right to left',
      files: 'In your own Google Drive or OneDrive',
      strong: 'Client approvals, a client portal and every screen in Arabic or English',
    } satisfies Record<AlternativeRow, string>,
    seePricing: (name: string) => `See ${name}’s pricing page`,
    ahead: (name: string) => `${name} is ahead here`,
    checked: (date: string) => `Last checked ${date}`,
    sources: 'Sources:',
    trademark: (name: string) =>
      `${name} is a trademark of its owner. TManage is not affiliated with ${name}.`,
    switchEyebrow: 'Switching',
    switchTitle: 'What you keep, what changes',
    switchLede: (name: string) =>
      `Moving from ${name} keeps the way your team already works and adds what agencies ask for.`,
    keepTitle: 'What you keep',
    keep: (work: string) => [
      `Projects and ${work}`,
      'Files and conversations',
      'Clients in the loop',
    ],
    changeTitle: 'What changes',
    changes: (fit: AlternativeFit) => [
      'Approvals tied to the exact version',
      'A workload view for the whole team',
      fit.theyHaveArabic ? 'Client users are always free' : 'Every screen in Arabic or English',
    ],
    switchButton: (name: string) => `See how to switch from ${name}`,
    faqEyebrow: 'Questions',
    faqTitle: (name: string) => `Questions about moving from ${name}`,
    faq: (name: string, work: string, fit: AlternativeFit) => [
      {
        question: `Is TManage a good ${name} alternative for a 10-person agency?`,
        answer:
          'Yes, if your clients approve work and you want one flat team price. TManage is free during the beta, and client users are always free.',
      },
      {
        question: 'Does TManage work in Arabic?',
        answer:
          'Yes. Every screen works in Arabic, right to left, and in English. Each person picks their own language.',
      },
      fit.hasSwitchPage
        ? {
            question: `Can I move my ${name} projects to TManage?`,
            answer: `Yes. The switch guide shows, step by step, how to bring your projects and ${work} across.`,
          }
        : {
            question: 'Do my clients need a paid seat in TManage?',
            answer:
              'No. Client users are always free, and they see and approve work in their own portal.',
          },
    ],
    relatedEyebrow: 'Related',
    relatedTitle: 'Keep comparing',
    compareCard: (name: string) => `TManage vs ${name}`,
    compareCardHint: 'The full side-by-side comparison',
    switchCard: (name: string) => `Switch from ${name}`,
    switchCardHint: 'Move your projects step by step',
    portalCard: 'The client portal',
    portalCardHint: 'What your clients see and approve',
    allCard: 'All alternatives',
    allCardHint: (names: readonly string[]) => `${names.join(', ')} and more`,
    indexTitle: 'Alternatives to the tools agencies use',
    indexDescription:
      'TManage is an alternative to Basecamp, monday.com, ClickUp, Asana, Wrike, Notion and more, for agencies that need client approvals, a client portal and Arabic.',
    indexLede:
      'TManage is an alternative to Basecamp, monday.com, ClickUp, Asana, Wrike, Notion and more, for agencies that need client approvals, a client portal and Arabic. Each page compares fairly, with dated facts and sources.',
    listEyebrow: 'Compare',
    listTitle: 'Pick the tool you use today',
    listLede: 'Each page shows where TManage fits, where the other tool is ahead, and how to move.',
    cardTitle: (name: string) => `${name} alternative`,
    indexNote:
      'All product names are trademarks of their owners. TManage is not affiliated with them.',
  },
  ar: {
    alternatives: 'البدائل',
    eyebrow: (name: string) => `بديل ${RLM}${name}`,
    title: (name: string) => `بديل ${RLM}${name} للوكالات`,
    tabTitle: (name: string) => `بديل ${RLM}${name} للوكالات`,
    description: (name: string) =>
      `${RLM}TManage بديل عن ${RLM}${name} للوكالات التي تحتاج إلى اعتماد العملاء، وبوابة خاصة بهم، وسعر ثابت للفريق كله.`,
    lede: (name: string) =>
      `${RLM}TManage بديل عن ${RLM}${name} للوكالات التي تحتاج إلى اعتماد العملاء، وبوابة خاصة بهم، وسعر ثابت للفريق كله. مجاني طوال فترة البيتا، ويعمل بالكامل بالعربية والإنجليزية.`,
    compareButton: 'شاهد المقارنة كاملة',
    whyEyebrow: 'لماذا يبحثون عن بديل',
    whyTitle: (name: string) => `لماذا تنتقل بعض الفرق من ${RLM}${name}؟`,
    reasons: (name: string, fit: AlternativeFit) => [
      fit.theyHaveArabic
        ? {
            title: 'كل شخص يختار لغته',
            body: `مثل ${RLM}${name}، يعمل ${RLM}TManage بالعربية من اليمين لليسار، وكل شخص يختار العربية أو الإنجليزية لشاشاته.`,
          }
        : {
            title: 'فريقك يعمل بالعربية',
            body: `في ${RLM}TManage كل شاشة تعمل بالعربية من اليمين لليسار، وبالإنجليزية أيضًا، وكل شخص يختار لغته.`,
          },
      {
        title: 'عملاؤك يعتمدون الأعمال',
        body: fit.theyListClients
          ? `يوضّح الجدول أدناه كيف يُدخل ${RLM}${name} العملاء في العمل، ويضيف ${RLM}TManage اعتمادًا مرتبطًا بالنسخة نفسها.`
          : `في ${RLM}TManage يعمل العملاء من بوابتهم الخاصة ويعتمدون النسخة نفسها، وحسابات العملاء مجانية دائمًا.`,
      },
      {
        title: 'الفريق يكبر باستمرار',
        body: `بعد البيتا، يدفع الفريق في ${RLM}TManage سعرًا ثابتًا واحدًا، ولا يُحتسب العملاء أبدًا. قارن ذلك بصفحة أسعار ${RLM}${name}.`,
      },
    ],
    tableEyebrow: 'مقارنة مباشرة',
    tableTitle: (name: string) => `${RLM}TManage و ${RLM}${name} جنبًا إلى جنب`,
    tableLede: (name: string) =>
      `حقائق واضحة راجعناها بأنفسنا. وحيث يتفوّق ${RLM}${name}، يذكر الجدول ذلك.`,
    need: 'وجه المقارنة',
    rows: {
      pricing: 'التسعير',
      tasks: 'المهام',
      clients: 'وصول العملاء',
      time: 'تسجيل الوقت',
      arabic: 'واجهة عربية',
      invoices: 'الفواتير',
      files: 'الملفات',
    },
    strongRow: (name: string) => `نقاط قوة ${RLM}${name}`,
    ours: {
      pricing: 'مجاني طوال البيتا، ثم سعر ثابت واحد للفريق، ولا يُحتسب العملاء',
      tasks: 'المشاريع والمهام واللوحات والقوائم والتقويم',
      clients: 'بوابة للعملاء، والعميل يعتمد النسخة نفسها',
      time: 'مؤقّت لتسجيل الوقت',
      invoices: 'نعم، فواتير وعروض أسعار (الدفع الإلكتروني غير متاح بعد)',
      arabic: 'نعم، من اليمين لليسار بالكامل',
      files: `في ${RLM}Google Drive أو ${RLM}OneDrive الخاص بشركتك`,
      strong: 'اعتماد العملاء، وبوابة خاصة بهم، وكل شاشة بالعربية أو الإنجليزية',
    } satisfies Record<AlternativeRow, string>,
    seePricing: (name: string) => `راجع صفحة أسعار ${RLM}${name}`,
    ahead: (name: string) => `هنا يتفوّق ${RLM}${name}`,
    checked: (date: string) => `آخر مراجعة: ${date}`,
    sources: 'المصادر:',
    trademark: (name: string) =>
      `${RLM}${name} علامة تجارية مملوكة لأصحابها، و ${RLM}TManage غير تابع لها.`,
    switchEyebrow: 'الانتقال',
    switchTitle: 'ما يبقى وما يتغيّر',
    switchLede: (name: string) =>
      `الانتقال من ${RLM}${name} يحافظ على طريقة عمل فريقك، ويضيف ما تحتاجه الوكالات.`,
    keepTitle: 'ما يبقى',
    keep: (_work: string) => ['المشاريع والمهام', 'الملفات والمحادثات', 'العملاء على اطلاع دائم'],
    changeTitle: 'ما يتغيّر',
    changes: (fit: AlternativeFit) => [
      'اعتماد مرتبط بالنسخة نفسها',
      'عرض لعبء العمل على الفريق كله',
      fit.theyHaveArabic ? 'حسابات العملاء مجانية دائمًا' : 'كل شاشة بالعربية أو الإنجليزية',
    ],
    switchButton: (name: string) => `خطوات الانتقال من ${RLM}${name}`,
    faqEyebrow: 'أسئلة',
    faqTitle: (name: string) => `أسئلة عن الانتقال من ${RLM}${name}`,
    faq: (name: string, _work: string, fit: AlternativeFit) => [
      {
        question: `هل ${RLM}TManage بديل مناسب عن ${RLM}${name} لوكالة من 10 أشخاص؟`,
        answer: `نعم، إذا كان عملاؤك يعتمدون الأعمال وتريد سعرًا ثابتًا للفريق. ${RLM}TManage مجاني طوال البيتا، وحسابات العملاء مجانية دائمًا.`,
      },
      {
        question: `هل يعمل ${RLM}TManage بالعربية؟`,
        answer:
          'نعم. كل شاشة تعمل بالعربية من اليمين لليسار، وبالإنجليزية أيضًا، وكل شخص يختار لغته.',
      },
      fit.hasSwitchPage
        ? {
            question: `هل أستطيع نقل مشاريعي من ${RLM}${name}؟`,
            answer: 'نعم. دليل الانتقال يشرح خطوة بخطوة كيف تنقل مشاريعك ومهامك.',
          }
        : {
            question: `هل يحتاج عملائي إلى مقاعد مدفوعة في ${RLM}TManage؟`,
            answer: 'لا. حسابات العملاء مجانية دائمًا، ويرون الأعمال ويعتمدونها من بوابتهم الخاصة.',
          },
    ],
    relatedEyebrow: 'روابط ذات صلة',
    relatedTitle: 'تابع المقارنة',
    compareCard: (name: string) => `${RLM}TManage مقابل ${RLM}${name}`,
    compareCardHint: 'المقارنة الكاملة جنبًا إلى جنب',
    switchCard: (name: string) => `الانتقال من ${RLM}${name}`,
    switchCardHint: 'انقل مشاريعك خطوة بخطوة',
    portalCard: 'بوابة العملاء',
    portalCardHint: 'ما يراه عملاؤك ويعتمدونه',
    allCard: 'كل البدائل',
    allCardHint: (names: readonly string[]) =>
      `${names.map((name) => `${RLM}${name}`).join(' و ')} وغيرها`,
    indexTitle: 'بدائل للأدوات التي تستخدمها الوكالات',
    indexDescription: `${RLM}TManage بديل عن ${RLM}Basecamp و ${RLM}monday.com و ${RLM}ClickUp و ${RLM}Asana و ${RLM}Wrike و ${RLM}Notion وغيرها، للوكالات التي تحتاج إلى اعتماد العملاء وبوابة خاصة بهم وواجهة عربية.`,
    indexLede: `${RLM}TManage بديل عن ${RLM}Basecamp و ${RLM}monday.com و ${RLM}ClickUp و ${RLM}Asana و ${RLM}Wrike و ${RLM}Notion وغيرها، للوكالات التي تحتاج إلى اعتماد العملاء وبوابة خاصة بهم وواجهة عربية. كل صفحة تقارن بإنصاف، بحقائق مؤرخة ومصادر واضحة.`,
    listEyebrow: 'قارن',
    listTitle: 'اختر الأداة التي تستخدمها اليوم',
    listLede: `كل صفحة توضّح أين يناسبك ${RLM}TManage، وأين تتفوّق الأداة الأخرى، وكيف تنتقل.`,
    cardTitle: (name: string) => `بديل ${RLM}${name}`,
    indexNote: `جميع أسماء المنتجات علامات تجارية مملوكة لأصحابها، و ${RLM}TManage غير تابع لأي منها.`,
  },
} satisfies Record<CompareLanguage, unknown>;

export type AlternativeCopy = (typeof ALTERNATIVE_COPY)['en'];
