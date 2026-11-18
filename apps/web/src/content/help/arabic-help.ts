import type { HelpArticle } from './help-articles';

/** U+200F before a Latin word where Arabic text continues (as on the compare pages). */
const RLM = '‏';

/**
 * Row 57-07 (MENA) — the Help centre's Arabic-first starter set (Figma 725:40484 AR / 725:40362
 * EN): the "Arabic and language" topic, and the two client-approval articles the region's agencies
 * ask about first. Written in Arabic and English side by side like every article; the steps name
 * the app's own labels (`ar.json` / `en.json`: `LanguagePicker.label`, `DisplayPreferencesView.*`,
 * `ExternalApprovers.*`, `ApproverLink.*`, `VerifyRecord.*`), so a reader finds them on screen.
 */
export const ARABIC_HELP_ARTICLES: readonly HelpArticle[] = [
  {
    slug: 'switch-to-arabic',
    category: 'arabic',
    minutes: 1,
    related: ['arabic-and-english-workspace', 'arabic-dates-and-numbers'],
    en: {
      title: 'Switch TManage to Arabic',
      summary: 'Choose Arabic for yourself, and the whole interface runs right to left.',
      body: [
        {
          kind: 'steps',
          items: ['Open your account menu.', 'Choose Language.', 'Choose العربية.'],
        },
        {
          kind: 'p',
          text: 'Menus, buttons and lists now run right to left. Numbers, links and file names keep their own direction, so they stay readable.',
        },
        { kind: 'tip', text: 'Your choice is yours alone: your team and clients keep their own.' },
      ],
      keywords: ['language', 'arabic', 'rtl', 'right to left', 'translate'],
    },
    ar: {
      title: `حوّل ${RLM}TManage إلى العربية`,
      summary: 'اختر العربية لنفسك، فتعمل الواجهة كلها من اليمين إلى اليسار.',
      body: [
        {
          kind: 'steps',
          items: ['افتح قائمة حسابك.', 'اختر «اللغة».', 'اختر «العربية».'],
        },
        {
          kind: 'p',
          text: 'القوائم والأزرار والجداول تعمل الآن من اليمين إلى اليسار. وتحتفظ الأرقام والروابط وأسماء الملفات باتجاهها، فتبقى سهلة القراءة.',
        },
        { kind: 'tip', text: 'اختيارك لك وحدك: يحتفظ فريقك وعملاؤك بلغاتهم.' },
      ],
      keywords: ['اللغة', 'عربي', 'العربية', 'يمين', 'ترجمة', 'اتجاه'],
    },
  },
  {
    slug: 'arabic-and-english-workspace',
    category: 'arabic',
    minutes: 2,
    related: ['switch-to-arabic', 'invite-your-team'],
    en: {
      title: 'Arabic and English in one workspace',
      summary: 'Each person reads TManage in their own language, and the work stays the same.',
      body: [
        {
          kind: 'p',
          text: 'Each person chooses their own language. One person can work in Arabic while the person next to them works in English, on the same tasks, files and approvals.',
        },
        {
          kind: 'steps',
          items: [
            'Each team member chooses their language from their account menu.',
            'Clients choose theirs in the client portal menu.',
            'Write task names and messages in whichever language suits the team. TManage shows them exactly as written.',
          ],
        },
      ],
      keywords: ['bilingual', 'two languages', 'mixed', 'english', 'arabic'],
    },
    ar: {
      title: 'العربية والإنجليزية في مساحة عمل واحدة',
      summary: `يقرأ كل شخص ${RLM}TManage بلغته، ويبقى العمل نفسه.`,
      body: [
        {
          kind: 'p',
          text: 'يختار كل شخص لغته بنفسه. يمكن لشخص أن يعمل بالعربية وزميله بجانبه بالإنجليزية، على المهام والملفات والموافقات نفسها.',
        },
        {
          kind: 'steps',
          items: [
            'يختار كل عضو في الفريق لغته من قائمة حسابه.',
            'ويختار العملاء لغتهم من قائمة بوابة العملاء.',
            `اكتب أسماء المهام والرسائل باللغة التي تناسب فريقك، ويعرضها ${RLM}TManage كما كُتبت.`,
          ],
        },
      ],
      keywords: ['لغتين', 'إنجليزي', 'عربي', 'مختلط', 'ثنائي اللغة'],
    },
  },
  {
    slug: 'arabic-dates-and-numbers',
    category: 'arabic',
    minutes: 1,
    related: ['switch-to-arabic', 'log-time-timesheets'],
    en: {
      title: 'Dates and numbers in Arabic',
      summary: 'Choose the digits you read, the date format and the day your week starts.',
      body: [
        {
          kind: 'steps',
          items: [
            'Open Preferences, then Appearance.',
            'Under Numbers, choose Latin (123) or Arabic-Indic (١٢٣).',
            'Choose the date format you read most easily.',
            'Under Week starts on, choose Saturday, Sunday or Monday.',
          ],
        },
        {
          kind: 'p',
          text: 'These choices apply to your account on every device. The live sample on the same page shows the result before you leave.',
        },
      ],
      keywords: ['digits', 'numerals', 'date format', 'week', 'saturday', 'sunday'],
    },
    ar: {
      title: 'التواريخ والأرقام بالعربية',
      summary: 'اختر شكل الأرقام وشكل التاريخ واليوم الذي يبدأ به أسبوعك.',
      body: [
        {
          kind: 'steps',
          items: [
            'افتح «التفضيلات» ثم «المظهر».',
            'من «الأرقام» اختر «إنجليزية (123)» أو «عربية (١٢٣)».',
            'اختر شكل التاريخ الأسهل لك في القراءة.',
            'من «يبدأ الأسبوع يوم» اختر السبت أو الأحد أو الاثنين.',
          ],
        },
        {
          kind: 'p',
          text: 'تُطبَّق هذه الاختيارات على حسابك في كل الأجهزة، ويعرض لك المثال الحي في الصفحة نفسها النتيجة قبل أن تغادرها.',
        },
      ],
      keywords: ['أرقام', 'هندية', 'تاريخ', 'أسبوع', 'السبت', 'الأحد'],
    },
  },
  {
    slug: 'send-for-client-approval',
    category: 'client-portal',
    minutes: 2,
    related: ['check-an-approval-record', 'what-clients-see'],
    en: {
      title: 'Send work to a client for approval',
      summary: 'Send one version to anyone by e-mail. They need no account to approve it.',
      body: [
        {
          kind: 'steps',
          items: [
            'Open the project, then Deliverables, and choose the version.',
            'Under Send for approval, enter the approver’s e-mail, and a name and message if you like.',
            'Choose how many days the link stays open, then choose Send for approval.',
            'They get a link by e-mail, ask for a 6-digit code, and choose Approve or Request changes.',
          ],
        },
        {
          kind: 'p',
          text: 'You can also copy the link and send it yourself, for example in the chat you already share with the client. The code still goes to their e-mail address, so only they can answer.',
        },
        {
          kind: 'tip',
          text: 'The list under the form shows who was asked and what each person answered.',
        },
      ],
      keywords: ['approve', 'client approval', 'link', 'sign off', 'whatsapp', 'phone'],
    },
    ar: {
      title: 'أرسل العمل للعميل ليعتمده',
      summary: 'أرسل نسخة واحدة إلى أي شخص بالبريد الإلكتروني، ولا يحتاج إلى حساب ليعتمدها.',
      body: [
        {
          kind: 'steps',
          items: [
            'افتح المشروع، ثم «التسليمات»، واختر النسخة.',
            'من «إرسال للاعتماد» أدخل البريد الإلكتروني للمعتمِد، واسمه ورسالة إن أردت.',
            'اختر عدد الأيام التي يبقى فيها الرابط مفتوحًا، ثم اختر «إرسال للاعتماد».',
            'يصله رابط بالبريد الإلكتروني، فيطلب رمزًا من 6 أرقام، ثم يختار «اعتماد» أو «طلب تعديلات».',
          ],
        },
        {
          kind: 'p',
          text: 'يمكنك أيضًا نسخ الرابط وإرساله بنفسك، مثلًا في المحادثة التي تجمعك بالعميل. يبقى الرمز مرسلًا إلى بريده، فلا يجيب غيره.',
        },
        {
          kind: 'tip',
          text: 'تعرض القائمة تحت النموذج من طُلب منه الاعتماد وبماذا أجاب كل شخص.',
        },
      ],
      keywords: ['اعتماد', 'موافقة العميل', 'رابط', 'واتساب', 'هاتف', 'موافقة'],
    },
  },
  {
    slug: 'check-an-approval-record',
    category: 'client-portal',
    minutes: 1,
    related: ['send-for-client-approval', 'what-clients-see'],
    en: {
      title: 'Check an approval record',
      summary: 'Anyone with the certificate can check that an approval is genuine.',
      body: [
        {
          kind: 'steps',
          items: [
            'Open the Verify page on the TManage website.',
            'Enter the record ID, printed under “Check this record” on the certificate.',
            'Enter the fingerprint, the long line of letters and numbers on the certificate.',
            'Choose Check record.',
          ],
        },
        {
          kind: 'p',
          text: 'The page says whether the record is genuine, when it was decided and in which workspace. It shows nothing else from the workspace.',
        },
      ],
      keywords: ['verify', 'certificate', 'proof', 'genuine', 'record'],
    },
    ar: {
      title: 'تحقّق من سجل اعتماد',
      summary: 'يستطيع أي شخص لديه الشهادة أن يتحقّق من أن الاعتماد أصلي.',
      body: [
        {
          kind: 'steps',
          items: [
            `افتح صفحة التحقّق في موقع ${RLM}TManage.`,
            'أدخل رقم السجل، المطبوع تحت «تحقّق من هذا السجل» في الشهادة.',
            'أدخل البصمة، وهي السطر الطويل من الحروف والأرقام في الشهادة.',
            'اختر «تحقّق من السجل».',
          ],
        },
        {
          kind: 'p',
          text: 'تخبرك الصفحة إن كان السجل أصليًا، ومتى اتُّخذ القرار، وفي أي مساحة عمل. ولا تعرض أي شيء آخر من مساحة العمل.',
        },
      ],
      keywords: ['تحقق', 'شهادة', 'إثبات', 'أصلي', 'سجل'],
    },
  },
];
