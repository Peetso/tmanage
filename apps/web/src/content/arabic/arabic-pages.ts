import { RLM, type CompareLanguage } from '../compare/compare-entries';
import type { ArabicUseCaseSlug } from './arabic-slugs';

/**
 * Row 57-07 (MENA) — the Arabic-first product page (`/arabic`, `/ar/arabic`; Figma 725:39834 AR /
 * 725:39970 EN) and its use-case pages (`/arabic/<slug>`; template 725:40234 AR / 725:40106 EN),
 * for agencies in the Gulf, Egypt and the Levant. Repo content, English and Arabic side by side
 * (the compare and facts pattern), so the two languages never drift.
 *
 * Every line is true of the product today (`content/facts/facts.ts`, and nothing the claims
 * registry `packages/domain/src/legal/public-claims.ts` holds back): the Arabic interface runs
 * right to left; a file version goes to a client for approval by link, with no account, and the
 * link and a 6-digit code arrive by e-mail (`ExternalApprovers.hint`); the link can also be copied
 * and sent by hand (`ExternalApprovers.copyHint`); the decision is kept on a record that can be
 * checked at `/verify`; files stay in Google Drive or OneDrive; free during the beta. No prices,
 * customers, logos or numbers. Arabic is simple Modern Standard Arabic that reads naturally to an
 * Egyptian reader; a line that opens with a Latin name starts with U+200F.
 */

/** The day these pages' words last changed (their sitemap date). */
export const ARABIC_KIT_UPDATED_ON = '2026-11-18';

export interface KitCard {
  readonly title: string;
  readonly body: string;
}

export const ARABIC_FIRST_COPY = {
  en: {
    tabTitle: 'Project management in Arabic for agencies',
    description:
      'TManage keeps tasks, files, client approvals and time in one place, and it works right to left in Arabic. For agencies in the Gulf, Egypt and the Levant. Free during the beta.',
    eyebrow: 'Built for Arabic first',
    title: 'Run your agency’s projects in Arabic, right to left',
    lede: 'TManage keeps tasks, files, client approvals and time in one place, and it works right to left in Arabic.',
    primary: 'Start a free workspace',
    secondary: 'See how approvals work',
    featuresLabel: 'What TManage gives you',
    features: [
      {
        title: 'A full Arabic interface',
        body: 'The interface runs right to left, and numbers, links and file names stay intact.',
      },
      {
        title: 'Client approval with one link',
        body: 'Send the client a link they open on their phone. They approve or ask for changes, and the decision is kept on record.',
      },
      {
        title: 'Your files stay where they are',
        body: 'Your files stay in Google Drive or OneDrive. TManage shows them to your team and your clients.',
      },
    ] satisfies KitCard[],
    previewTitle: 'What your team sees',
    previewDescription:
      'An approval card: the version is waiting for the client’s review, with the buttons Approve and Send back.',
    preview: {
      state: 'Review requested',
      since: 'since 9:40',
      name: 'Homepage hero · v3',
      project: 'Nile Studio · Atlas website',
      approve: 'Approve',
      sendBack: 'Send back',
    },
    storyTitle: 'An approval in three steps',
    story: [
      {
        title: 'The designer uploads version 3',
        body: 'She adds the file to the task, and it is ready for review.',
      },
      {
        title: 'The client gets a link on their phone',
        body: 'The link and a 6-digit code arrive by e-mail, or you copy the link into the chat you already share. They open it with no account and nothing to install.',
      },
      {
        title: 'The client approves',
        body: 'The decision is saved with the date and time, and can be checked later.',
      },
    ] satisfies KitCard[],
    pricingTitle: 'Pricing in the Gulf, Egypt and the Levant',
    pricing: [
      'TManage is free during the beta: every feature, and no card needed.',
      'After the beta there is one flat price per team, never per seat. Clients never count.',
    ],
    pricingLink: 'See pricing',
    useCasesTitle: 'Use cases',
    helpTitle: 'Help in Arabic',
    helpLede:
      'Short guides for switching to Arabic, mixing Arabic and English, and client approvals.',
    helpLink: 'Open the Help centre',
    betaNote: 'TManage is free during the beta.',
  },
  ar: {
    tabTitle: 'إدارة مشاريع الوكالات بالعربية',
    description: `${RLM}TManage يجمع المهام والملفات وموافقات العملاء والوقت في مكان واحد، ويعمل بالعربية من اليمين إلى اليسار. للوكالات في الخليج ومصر والشام. مجاني خلال الفترة التجريبية.`,
    eyebrow: 'مصمَّم للعربية أولًا',
    title: 'أدِر مشاريع وكالتك بالعربية، من اليمين إلى اليسار',
    lede: `${RLM}TManage يجمع المهام والملفات وموافقات العملاء والوقت في مكان واحد، ويعمل بالعربية من اليمين إلى اليسار.`,
    primary: 'ابدأ مساحة عمل مجانية',
    secondary: 'شاهد كيف تعمل الموافقات',
    featuresLabel: `ما يقدّمه لك ${RLM}TManage`,
    features: [
      {
        title: 'واجهة عربية كاملة',
        body: 'الواجهة من اليمين إلى اليسار، والأرقام والروابط وأسماء الملفات تبقى سليمة.',
      },
      {
        title: 'موافقة العميل برابط واحد',
        body: 'أرسل للعميل رابطًا يفتحه على هاتفه، فيعتمد أو يطلب تعديلات، ويُحفظ القرار في سجل.',
      },
      {
        title: 'ملفاتك في مكانها',
        body: `تبقى ملفاتك في ${RLM}Google Drive أو ${RLM}OneDrive، ويعرضها ${RLM}TManage لفريقك ولعملائك.`,
      },
    ] satisfies KitCard[],
    previewTitle: 'هكذا يراها فريقك',
    previewDescription:
      'بطاقة موافقة: النسخة بانتظار مراجعة العميل، ومعها زرّا «اعتمد» و«أعِد للتعديل».',
    preview: {
      state: 'بانتظار المراجعة',
      since: 'منذ 9:40',
      name: 'واجهة الصفحة الرئيسية · النسخة 3',
      project: `${RLM}Nile Studio · موقع ${RLM}Atlas`,
      approve: 'اعتمد',
      sendBack: 'أعِد للتعديل',
    },
    storyTitle: 'موافقة في ثلاث خطوات',
    story: [
      {
        title: 'ترفع المصممة النسخة 3',
        body: 'تضيف الملف إلى المهمة، فيصبح جاهزًا للمراجعة.',
      },
      {
        title: 'يصل للعميل رابط على هاتفه',
        body: 'يصله الرابط ورمز من 6 أرقام بالبريد الإلكتروني، أو تنسخ الرابط وترسله في المحادثة التي تجمعكما. يفتحه دون حساب ودون تثبيت أي تطبيق.',
      },
      {
        title: 'يعتمد العميل',
        body: 'يُسجَّل القرار مع التاريخ والوقت، ويمكن التحقّق منه لاحقًا.',
      },
    ] satisfies KitCard[],
    pricingTitle: 'الأسعار في الخليج ومصر والشام',
    pricing: [
      `${RLM}TManage مجاني خلال الفترة التجريبية: كل المزايا، وبدون بطاقة دفع.`,
      'بعد الفترة التجريبية سعر ثابت واحد لكل فريق، وليس لكل مستخدم. ولا يُحتسب العملاء.',
    ],
    pricingLink: 'اطّلع على الأسعار',
    useCasesTitle: 'حالات الاستخدام',
    helpTitle: 'المساعدة بالعربية',
    helpLede:
      'أدلة قصيرة للانتقال إلى العربية، والعمل بالعربية والإنجليزية معًا، وموافقات العملاء.',
    helpLink: 'افتح مركز المساعدة',
    betaNote: `${RLM}TManage مجاني خلال الفترة التجريبية.`,
  },
} satisfies Record<CompareLanguage, unknown>;

export type ArabicFirstCopy = (typeof ARABIC_FIRST_COPY)['en'];

export interface UseCaseText {
  /** The card title on other pages ("More use cases"). */
  readonly name: string;
  /** The card line on other pages. */
  readonly line: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly lede: string;
  readonly before: string;
  readonly after: string;
  readonly steps: readonly KitCard[];
}

export interface UseCaseEntry {
  readonly slug: ArabicUseCaseSlug;
  /** A help article that goes with this use case (`content/help`). */
  readonly helpSlug: string;
  readonly en: UseCaseText;
  readonly ar: UseCaseText;
}

export const USE_CASE_ENTRIES: readonly UseCaseEntry[] = [
  {
    slug: 'client-approvals',
    helpSlug: 'send-for-client-approval',
    en: {
      name: 'Client approvals',
      line: 'One link per version, and a record of what the client decided.',
      eyebrow: 'Use case · Client approvals',
      title: 'Get the client’s approval without a long message thread',
      lede: 'Share one link per version. The client approves or asks for changes, and the decision stays with the file.',
      before: 'Versions in chats, notes in e-mail, and nobody knows which file was approved.',
      after: 'One link per version, one decision per link, and a record that can be checked later.',
      steps: [
        { title: 'Upload the version', body: 'Add the file to the task.' },
        {
          title: 'Send one link',
          body: 'The client needs no account. The link and a 6-digit code arrive by e-mail.',
        },
        { title: 'The client decides', body: 'They approve, or ask for changes with a note.' },
        {
          title: 'The record is kept',
          body: 'Date, time and file, and it can be checked later.',
        },
      ],
    },
    ar: {
      name: 'موافقات العملاء',
      line: 'رابط واحد لكل نسخة، وسجل لما قرّره العميل.',
      eyebrow: 'حالة استخدام · موافقات العملاء',
      title: 'احصل على موافقة العميل دون سلسلة رسائل طويلة',
      lede: 'شارك رابطًا واحدًا لكل نسخة. يعتمد العميل أو يطلب تعديلات، ويبقى القرار مع الملف.',
      before: 'نسخ في المحادثات، وملاحظات في البريد، ولا أحد يعرف أي ملف اعتُمد.',
      after: 'رابط لكل نسخة، وقرار لكل رابط، وسجل يمكن التحقّق منه لاحقًا.',
      steps: [
        { title: 'ارفع النسخة', body: 'أضف الملف إلى المهمة.' },
        {
          title: 'أرسل رابطًا واحدًا',
          body: 'لا يحتاج العميل إلى حساب. يصله الرابط ورمز من 6 أرقام بالبريد الإلكتروني.',
        },
        { title: 'يقرّر العميل', body: 'يعتمد، أو يطلب تعديلات مع ملاحظة.' },
        { title: 'يُحفظ السجل', body: 'التاريخ والوقت والملف، ويمكن التحقّق منه لاحقًا.' },
      ],
    },
  },
  {
    slug: 'monthly-clients',
    helpSlug: 'log-time-timesheets',
    en: {
      name: 'Time tracking for monthly clients',
      line: 'Log time for each client and see where the hours went.',
      eyebrow: 'Use case · Monthly clients',
      title: 'Know where a monthly client’s hours went',
      lede: 'Log time on each client’s tasks as the work happens, then bring the approved hours into the client’s invoice.',
      before:
        'Hours pieced together from memory at the end of the month, and nobody is sure what was spent on which client.',
      after:
        'Time sits on the client’s own tasks, the week is approved in Timesheets, and the invoice starts from the approved hours.',
      steps: [
        {
          title: 'Log the time',
          body: 'Start the timer on a task, or add the minutes by hand.',
        },
        {
          title: 'Approve the week',
          body: 'Each person submits their week in Timesheets, and a manager approves it.',
        },
        {
          title: 'Bring it into the invoice',
          body: 'In the client’s invoice draft, choose Bring in to add the approved time.',
        },
        {
          title: 'The client sees the invoice',
          body: 'It is sent to the client and shown in their portal. Online payment is not available yet.',
        },
      ],
    },
    ar: {
      name: 'تتبّع الوقت للعملاء الشهريين',
      line: 'سجّل الوقت لكل عميل واعرف أين ذهبت الساعات.',
      eyebrow: 'حالة استخدام · العملاء الشهريون',
      title: 'اعرف أين ذهبت ساعات عميلك الشهري',
      lede: 'سجّل الوقت على مهام كل عميل أثناء العمل، ثم أضف الساعات المعتمدة إلى فاتورة العميل.',
      before: 'ساعات تُجمع من الذاكرة في آخر الشهر، ولا أحد متأكد كم صُرف على كل عميل.',
      after:
        'الوقت مسجّل على مهام العميل نفسه، والأسبوع معتمد في «سجلات ساعات العمل»، والفاتورة تبدأ من الساعات المعتمدة.',
      steps: [
        { title: 'سجّل الوقت', body: 'شغّل المؤقّت على مهمة، أو أضف الدقائق بنفسك.' },
        {
          title: 'اعتمد الأسبوع',
          body: 'يرسل كل شخص أسبوعه من «سجلات ساعات العمل»، ويعتمده المدير.',
        },
        {
          title: 'أضفه إلى الفاتورة',
          body: 'في مسودة فاتورة العميل، اختر «إضافة» لإضافة الوقت المعتمد.',
        },
        {
          title: 'يرى العميل الفاتورة',
          body: 'تُرسل إلى العميل وتظهر في بوابته. الدفع الإلكتروني غير متاح بعد.',
        },
      ],
    },
  },
  {
    slug: 'arabic-and-english',
    helpSlug: 'arabic-and-english-workspace',
    en: {
      name: 'Arabic and English in one team',
      line: 'Each person picks their language, and the work stays the same.',
      eyebrow: 'Use case · Arabic and English',
      title: 'One team, two languages, the same work',
      lede: 'Each person chooses Arabic or English for themselves. Tasks, files and approvals are the same for everyone.',
      before:
        'Part of the team thinks in Arabic, part in English, and the tool makes everyone use one language.',
      after:
        'Each person reads TManage in their own language, and everyone works on the same tasks and files.',
      steps: [
        {
          title: 'Choose your language',
          body: 'Open your account menu, choose Language, then العربية or English.',
        },
        {
          title: 'Arabic runs right to left',
          body: 'The interface mirrors, and numbers, links and file names stay intact.',
        },
        {
          title: 'Set numbers and the week',
          body: 'In Preferences, Appearance, choose the numbers you read and the day your week starts.',
        },
        {
          title: 'Clients choose too',
          body: 'Clients pick their own language in the client portal.',
        },
      ],
    },
    ar: {
      name: 'العربية والإنجليزية في فريق واحد',
      line: 'يختار كل شخص لغته، ويبقى العمل نفسه.',
      eyebrow: 'حالة استخدام · العربية والإنجليزية',
      title: 'فريق واحد، ولغتان، والعمل نفسه',
      lede: 'يختار كل شخص العربية أو الإنجليزية لنفسه، وتبقى المهام والملفات والموافقات واحدة للجميع.',
      before: 'جزء من الفريق يفكّر بالعربية وجزء بالإنجليزية، والأداة تفرض لغة واحدة على الجميع.',
      after: `يقرأ كل شخص ${RLM}TManage بلغته، ويعمل الجميع على المهام والملفات نفسها.`,
      steps: [
        {
          title: 'اختر لغتك',
          body: `افتح قائمة حسابك، واختر «اللغة»، ثم العربية أو ${RLM}English.`,
        },
        {
          title: 'العربية من اليمين إلى اليسار',
          body: 'تنعكس الواجهة، وتبقى الأرقام والروابط وأسماء الملفات سليمة.',
        },
        {
          title: 'اضبط الأرقام والأسبوع',
          body: 'من «التفضيلات · المظهر» اختر شكل الأرقام واليوم الذي يبدأ به أسبوعك.',
        },
        { title: 'والعملاء يختارون أيضًا', body: 'يختار العملاء لغتهم في بوابة العملاء.' },
      ],
    },
  },
];

export const USE_CASE_COPY = {
  en: {
    crumb: 'In Arabic',
    beforeAfter: 'Before and after',
    before: 'Before',
    after: 'With TManage',
    how: 'How it works',
    stepsLabel: 'Steps',
    primary: 'Start a free workspace',
    help: 'Read the help article',
    more: 'More use cases',
    readMore: 'Read more',
    tabTitle: (name: string) => `${name} for agencies`,
  },
  ar: {
    crumb: 'بالعربية',
    beforeAfter: 'قبل وبعد',
    before: 'قبل',
    after: `${RLM}مع TManage`,
    how: 'كيف يعمل ذلك',
    stepsLabel: 'الخطوات',
    primary: 'ابدأ مساحة عمل مجانية',
    help: 'اقرأ مقالة المساعدة',
    more: 'حالات استخدام أخرى',
    readMore: 'اقرأ المزيد',
    tabTitle: (name: string) => `${name} للوكالات`,
  },
} satisfies Record<CompareLanguage, unknown>;

const BY_SLUG: ReadonlyMap<string, UseCaseEntry> = new Map(
  USE_CASE_ENTRIES.map((entry) => [entry.slug, entry]),
);

export function findUseCase(slug: string): UseCaseEntry | undefined {
  return BY_SLUG.get(slug);
}

/** Every use case but `slug`, in list order (the "More use cases" cards). */
export function otherUseCases(slug?: string): UseCaseEntry[] {
  return USE_CASE_ENTRIES.filter((entry) => entry.slug !== slug);
}

/** The English text of the product page, for `llms-full.txt` and `/md/arabic`. */
export function arabicFirstMarkdown(): string[] {
  const copy = ARABIC_FIRST_COPY.en;
  return [
    copy.lede,
    ...copy.features.map((card) => `## ${card.title}\n\n${card.body}`),
    `## ${copy.storyTitle}`,
    copy.story.map((card, index) => `${index + 1}. **${card.title}.** ${card.body}`).join('\n'),
    `## ${copy.pricingTitle}`,
    copy.pricing.join(' '),
  ];
}

/** The English text of one use case, for `llms-full.txt` and `/md/arabic/<slug>`. */
export function useCaseMarkdown(slug: string): string[] {
  const entry = findUseCase(slug);
  if (entry === undefined) return [];
  const words = USE_CASE_COPY.en;
  return [
    entry.en.lede,
    `## ${words.beforeAfter}`,
    `- **${words.before}:** ${entry.en.before}\n- **${words.after}:** ${entry.en.after}`,
    `## ${words.how}`,
    entry.en.steps.map((step, index) => `${index + 1}. **${step.title}.** ${step.body}`).join('\n'),
  ];
}
