/**
 * Row 55-16 — the public Help centre's articles (`/help`, `/help/<slug>`, Arabic at `/ar/help`).
 *
 * Repo content, not API data: each article is written in English and in Arabic side by side, so
 * the two languages never drift. Arabic is Modern Standard Arabic product language; brand names
 * (TManage, Google Drive, OneDrive) stay in Latin script. Figma: R35 L2-55-16 on the Product page.
 */

export type HelpLanguage = 'en' | 'ar';

export type HelpCategoryId =
  'getting-started' | 'projects' | 'tasks' | 'client-portal' | 'files' | 'time-money' | 'security';

export interface HelpCategory {
  id: HelpCategoryId;
  icon: 'bolt' | 'briefcase' | 'check' | 'portal' | 'doc' | 'chart' | 'shield';
  title: Record<HelpLanguage, string>;
  blurb: Record<HelpLanguage, string>;
}

export type HelpBlock =
  | { kind: 'p'; text: string }
  | { kind: 'steps'; items: readonly string[] }
  | { kind: 'tip'; text: string };

export interface HelpArticleText {
  title: string;
  summary: string;
  body: readonly HelpBlock[];
  /** Extra words people search with that do not appear in the text. */
  keywords?: readonly string[];
}

export interface HelpArticle {
  slug: string;
  category: HelpCategoryId;
  minutes: number;
  related: readonly string[];
  en: HelpArticleText;
  ar: HelpArticleText;
}

export const HELP_CATEGORIES: readonly HelpCategory[] = [
  {
    id: 'getting-started',
    icon: 'bolt',
    title: { en: 'Getting started', ar: 'البدء' },
    blurb: {
      en: 'Set up your workspace and bring your team in.',
      ar: 'جهّز مساحة عملك وأضف فريقك.',
    },
  },
  {
    id: 'projects',
    icon: 'briefcase',
    title: { en: 'Projects', ar: 'المشاريع' },
    blurb: {
      en: 'Plan the work, the milestones and the dates.',
      ar: 'خطّط للعمل والمراحل والتواريخ.',
    },
  },
  {
    id: 'tasks',
    icon: 'check',
    title: { en: 'Tasks', ar: 'المهام' },
    blurb: {
      en: 'Assign work, follow it and get it approved.',
      ar: 'أسند العمل وتابعه واحصل على اعتماده.',
    },
  },
  {
    id: 'client-portal',
    icon: 'portal',
    title: { en: 'Client portal', ar: 'بوابة العملاء' },
    blurb: {
      en: 'Share progress with clients and collect decisions.',
      ar: 'شارك التقدّم مع العملاء واحصل على قراراتهم.',
    },
  },
  {
    id: 'files',
    icon: 'doc',
    title: { en: 'Files', ar: 'الملفات' },
    blurb: {
      en: 'Keep versions in one place, wherever they are stored.',
      ar: 'احتفظ بالنسخ في مكان واحد أينما كانت مخزّنة.',
    },
  },
  {
    id: 'time-money',
    icon: 'chart',
    title: { en: 'Time & money', ar: 'الوقت والمال' },
    blurb: {
      en: 'Track time, expenses and invoices.',
      ar: 'تتبّع الوقت والمصروفات والفواتير.',
    },
  },
  {
    id: 'security',
    icon: 'shield',
    title: { en: 'Security', ar: 'الأمان' },
    blurb: {
      en: 'Protect accounts, sessions and data.',
      ar: 'احمِ الحسابات والجلسات والبيانات.',
    },
  },
];

export const HELP_ARTICLES: readonly HelpArticle[] = [
  {
    slug: 'create-your-workspace',
    category: 'getting-started',
    minutes: 2,
    related: ['invite-your-team', 'start-a-project'],
    en: {
      title: 'Create your workspace',
      summary: 'Your workspace holds your company’s projects, people and clients.',
      body: [
        {
          kind: 'p',
          text: 'Sign up with your work email. TManage creates a workspace for your company with its own web address.',
        },
        {
          kind: 'steps',
          items: [
            'Open tmanageapp.com and choose Start free.',
            'Confirm your email with the code we send you.',
            'Name your workspace and choose its language and time zone.',
            'Create your first project, or skip and explore first.',
          ],
        },
        { kind: 'tip', text: 'You can change the workspace name and language later in Settings.' },
      ],
      keywords: ['sign up', 'account', 'organization', 'start'],
    },
    ar: {
      title: 'أنشئ مساحة عملك',
      summary: 'تضمّ مساحة العمل مشاريع شركتك وفريقها وعملاءها.',
      body: [
        {
          kind: 'p',
          text: 'سجّل باستخدام بريد العمل، وسينشئ TManage مساحة عمل لشركتك بعنوان ويب خاص بها.',
        },
        {
          kind: 'steps',
          items: [
            'افتح tmanageapp.com واختر «ابدأ مجانًا».',
            'أكّد بريدك الإلكتروني بالرمز الذي نرسله إليك.',
            'سمِّ مساحة العمل واختر لغتها ومنطقتها الزمنية.',
            'أنشئ مشروعك الأول، أو تخطَّ هذه الخطوة واستكشف أولًا.',
          ],
        },
        { kind: 'tip', text: 'يمكنك تغيير اسم مساحة العمل ولغتها لاحقًا من الإعدادات.' },
      ],
      keywords: ['تسجيل', 'حساب', 'منظمة', 'بداية'],
    },
  },
  {
    slug: 'invite-your-team',
    category: 'getting-started',
    minutes: 2,
    related: ['create-your-workspace', 'create-and-assign-tasks'],
    en: {
      title: 'Invite your team and set roles',
      summary: 'Bring colleagues in and decide what each of them can do.',
      body: [
        {
          kind: 'p',
          text: 'Every person in a workspace has a role. The role decides what they can see and change.',
        },
        {
          kind: 'steps',
          items: [
            'Go to People and choose Invite.',
            'Enter one or more email addresses.',
            'Pick a role for each person: Owner, Admin, Member or Guest.',
            'Send the invitation. It stays valid for seven days.',
          ],
        },
        {
          kind: 'tip',
          text: 'Give the smallest role that lets someone do their job. You can raise it later.',
        },
      ],
      keywords: ['members', 'people', 'permissions', 'admin'],
    },
    ar: {
      title: 'ادعُ فريقك وحدّد الأدوار',
      summary: 'أضف زملاءك وحدّد ما يستطيع كل منهم فعله.',
      body: [
        { kind: 'p', text: 'لكل شخص في مساحة العمل دور، والدور يحدّد ما يمكنه رؤيته وتعديله.' },
        {
          kind: 'steps',
          items: [
            'انتقل إلى «الأشخاص» واختر «دعوة».',
            'أدخل عنوان بريد إلكتروني واحدًا أو أكثر.',
            'اختر دورًا لكل شخص: مالك أو مسؤول أو عضو أو ضيف.',
            'أرسل الدعوة، وتبقى صالحة سبعة أيام.',
          ],
        },
        { kind: 'tip', text: 'امنح أصغر دور يتيح للشخص إنجاز عمله، ويمكنك رفعه لاحقًا.' },
      ],
      keywords: ['أعضاء', 'أشخاص', 'صلاحيات', 'مسؤول'],
    },
  },
  {
    slug: 'start-a-project',
    category: 'projects',
    minutes: 3,
    related: ['milestones-and-dates', 'create-and-assign-tasks'],
    en: {
      title: 'Start a project from scratch or a template',
      summary: 'A project groups the tasks, files and people for one piece of client work.',
      body: [
        {
          kind: 'steps',
          items: [
            'Open Projects and choose New project.',
            'Start blank, or pick a template such as Website relaunch.',
            'Name the project and link it to a client if there is one.',
            'Add the people who will work on it.',
          ],
        },
        {
          kind: 'p',
          text: 'A template copies its phases, tasks and review points into the new project, so you only adjust the dates.',
        },
      ],
      keywords: ['new project', 'template', 'create'],
    },
    ar: {
      title: 'ابدأ مشروعًا من الصفر أو من قالب',
      summary: 'يجمع المشروع المهام والملفات والأشخاص لعمل واحد لعميل.',
      body: [
        {
          kind: 'steps',
          items: [
            'افتح «المشاريع» واختر «مشروع جديد».',
            'ابدأ بمشروع فارغ، أو اختر قالبًا مثل «إعادة إطلاق موقع».',
            'سمِّ المشروع واربطه بعميل إن وُجد.',
            'أضف الأشخاص الذين سيعملون عليه.',
          ],
        },
        {
          kind: 'p',
          text: 'ينسخ القالب مراحله ومهامه ونقاط مراجعته إلى المشروع الجديد، فلا يبقى عليك سوى ضبط التواريخ.',
        },
      ],
      keywords: ['مشروع جديد', 'قالب', 'إنشاء'],
    },
  },
  {
    slug: 'milestones-and-dates',
    category: 'projects',
    minutes: 3,
    related: ['start-a-project', 'task-approval'],
    en: {
      title: 'Milestones and the three dates',
      summary:
        'Wanted, committed and forecast dates tell different stories. Here is how to read them.',
      body: [
        {
          kind: 'p',
          text: 'Every milestone can carry three dates. Keeping them apart stops a wish from looking like a promise.',
        },
        {
          kind: 'steps',
          items: [
            'Wanted date: when the client would like it.',
            'Committed date: what the team has agreed to deliver.',
            'Forecast date: where the plan honestly says it will land.',
          ],
        },
        {
          kind: 'tip',
          text: 'When the forecast passes the committed date, the milestone turns amber so you can talk to the client early.',
        },
      ],
      keywords: ['deadline', 'due date', 'schedule', 'timeline'],
    },
    ar: {
      title: 'المراحل والتواريخ الثلاثة',
      summary: 'التاريخ المرغوب والملتزَم به والمتوقَّع تحكي قصصًا مختلفة، وهذه طريقة قراءتها.',
      body: [
        {
          kind: 'p',
          text: 'يمكن لكل مرحلة أن تحمل ثلاثة تواريخ، والفصل بينها يمنع الأمنية من أن تبدو وعدًا.',
        },
        {
          kind: 'steps',
          items: [
            'التاريخ المرغوب: متى يريد العميل التسليم.',
            'التاريخ الملتزَم به: ما اتفق الفريق على تسليمه.',
            'التاريخ المتوقَّع: ما تقوله الخطة بصدق عن موعد الإنجاز.',
          ],
        },
        {
          kind: 'tip',
          text: 'إذا تجاوز التاريخ المتوقَّع التاريخ الملتزَم به، يتحوّل لون المرحلة إلى الكهرماني لتتحدث مع العميل مبكرًا.',
        },
      ],
      keywords: ['موعد نهائي', 'تاريخ التسليم', 'جدول', 'خط زمني'],
    },
  },
  {
    slug: 'create-and-assign-tasks',
    category: 'tasks',
    minutes: 2,
    related: ['task-approval', 'invite-your-team'],
    en: {
      title: 'Create and assign tasks',
      summary: 'Write what done looks like, name who does it and agree on a date.',
      body: [
        {
          kind: 'steps',
          items: [
            'Open a project and choose New task, or press N.',
            'Write a clear title and describe what done looks like.',
            'Add one or more doers, and watchers who should stay informed.',
            'Set a due date and a priority.',
          ],
        },
        {
          kind: 'tip',
          text: 'Watchers get updates but are not responsible for the work. Untick someone in the picker to remove them.',
        },
      ],
      keywords: ['todo', 'assign', 'assignee', 'watchers', 'work item'],
    },
    ar: {
      title: 'أنشئ المهام وأسندها',
      summary: 'صِف شكل العمل حين يكتمل، وسمِّ من ينفّذه، واتفقوا على تاريخ.',
      body: [
        {
          kind: 'steps',
          items: [
            'افتح مشروعًا واختر «مهمة جديدة»، أو اضغط N.',
            'اكتب عنوانًا واضحًا وصِف شكل العمل حين يكتمل.',
            'أضف منفّذًا واحدًا أو أكثر، ومتابعين يجب أن يبقوا على اطلاع.',
            'حدّد تاريخ الاستحقاق والأولوية.',
          ],
        },
        {
          kind: 'tip',
          text: 'يتلقى المتابعون التحديثات لكنهم ليسوا مسؤولين عن العمل. ألغِ تحديد الشخص في القائمة لإزالته.',
        },
      ],
      keywords: ['مهمة', 'إسناد', 'منفذ', 'متابعون'],
    },
  },
  {
    slug: 'task-approval',
    category: 'tasks',
    minutes: 2,
    related: ['create-and-assign-tasks', 'milestones-and-dates'],
    en: {
      title: 'Send a task for supervisor approval',
      summary: 'When a task has a supervisor, marking it done asks them to approve it first.',
      body: [
        {
          kind: 'steps',
          items: [
            'Open the task and add a supervisor under People.',
            'When the work is finished, choose Mark as done.',
            'The supervisor approves it, or sends it back with a note.',
          ],
        },
        {
          kind: 'p',
          text: 'Until it is approved the task shows Waiting for approval, and every doer can see who needs to act.',
        },
      ],
      keywords: ['approve', 'review', 'supervisor', 'done'],
    },
    ar: {
      title: 'أرسل المهمة لاعتماد المشرف',
      summary: 'إذا كان للمهمة مشرف، فإن وضع علامة «تمّت» يطلب موافقته أولًا.',
      body: [
        {
          kind: 'steps',
          items: [
            'افتح المهمة وأضف مشرفًا من قسم الأشخاص.',
            'عند انتهاء العمل، اختر «وضع علامة تمّت».',
            'يوافق المشرف عليها أو يعيدها مع ملاحظة.',
          ],
        },
        {
          kind: 'p',
          text: 'إلى أن تُعتمد، تظهر المهمة بحالة «بانتظار الاعتماد»، ويرى كل منفّذ من عليه التصرّف.',
        },
      ],
      keywords: ['اعتماد', 'موافقة', 'مراجعة', 'مشرف'],
    },
  },
  {
    slug: 'invite-a-client',
    category: 'client-portal',
    minutes: 2,
    related: ['what-clients-see', 'upload-and-share-files'],
    en: {
      title: 'Invite a client to the portal',
      summary: 'Clients get their own calm view of the project, without seeing your internal work.',
      body: [
        {
          kind: 'steps',
          items: [
            'Open Clients and choose the client company.',
            'Choose Invite contact and enter their email.',
            'Pick the projects this contact may open.',
            'They receive a sign-in link to the client portal.',
          ],
        },
        { kind: 'tip', text: 'Client contacts never count as paid seats.' },
      ],
      keywords: ['customer', 'guest', 'external', 'portal access'],
    },
    ar: {
      title: 'ادعُ عميلًا إلى البوابة',
      summary: 'يحصل العملاء على عرض هادئ خاص بهم للمشروع، دون رؤية عملكم الداخلي.',
      body: [
        {
          kind: 'steps',
          items: [
            'افتح «العملاء» واختر شركة العميل.',
            'اختر «دعوة جهة اتصال» وأدخل بريدها الإلكتروني.',
            'حدّد المشاريع التي يمكن لجهة الاتصال فتحها.',
            'تصلهم رسالة فيها رابط لتسجيل الدخول إلى بوابة العملاء.',
          ],
        },
        { kind: 'tip', text: 'لا تُحتسب جهات اتصال العملاء ضمن المقاعد المدفوعة.' },
      ],
      keywords: ['زبون', 'ضيف', 'خارجي', 'دخول البوابة'],
    },
  },
  {
    slug: 'what-clients-see',
    category: 'client-portal',
    minutes: 2,
    related: ['invite-a-client', 'two-step-sign-in'],
    en: {
      title: 'Choose what a client can see',
      summary: 'Everything starts internal. You decide, item by item, what the client sees.',
      body: [
        {
          kind: 'p',
          text: 'Tasks, files and updates are internal until you share them. The client badge shows what is visible in the portal.',
        },
        {
          kind: 'steps',
          items: [
            'Open the task, file or update.',
            'Choose Visibility and switch it to Client.',
            'Check the preview to see the portal as the client will.',
          ],
        },
        { kind: 'tip', text: 'The portal access log shows who opened what, and when.' },
      ],
      keywords: ['visibility', 'share', 'private', 'internal'],
    },
    ar: {
      title: 'اختر ما يراه العميل',
      summary: 'كل شيء يبدأ داخليًا، وأنت تقرّر عنصرًا عنصرًا ما يراه العميل.',
      body: [
        {
          kind: 'p',
          text: 'تبقى المهام والملفات والتحديثات داخلية حتى تشاركها، وتوضّح شارة العميل ما هو ظاهر في البوابة.',
        },
        {
          kind: 'steps',
          items: [
            'افتح المهمة أو الملف أو التحديث.',
            'اختر «الظهور» وحوّله إلى «العميل».',
            'راجع المعاينة لترى البوابة كما سيراها العميل.',
          ],
        },
        { kind: 'tip', text: 'يعرض سجل دخول البوابة من فتح ماذا ومتى.' },
      ],
      keywords: ['الظهور', 'مشاركة', 'خاص', 'داخلي'],
    },
  },
  {
    slug: 'upload-and-share-files',
    category: 'files',
    minutes: 2,
    related: ['connect-drive-onedrive', 'what-clients-see'],
    en: {
      title: 'Upload and share files',
      summary: 'Keep every version of a file in one place, with comments on each version.',
      body: [
        {
          kind: 'steps',
          items: [
            'Open the project and go to Files.',
            'Drag files in, or choose Upload.',
            'Upload a new version on top of an old one to keep the history.',
            'Share a version with the client when it is ready for review.',
          ],
        },
        {
          kind: 'tip',
          text: 'Ask the client for one decision per version: approve, or request changes.',
        },
      ],
      keywords: ['upload', 'documents', 'versions', 'attachments'],
    },
    ar: {
      title: 'ارفع الملفات وشاركها',
      summary: 'احتفظ بكل نسخ الملف في مكان واحد، مع تعليقات على كل نسخة.',
      body: [
        {
          kind: 'steps',
          items: [
            'افتح المشروع وانتقل إلى «الملفات».',
            'اسحب الملفات وأفلتها، أو اختر «رفع».',
            'ارفع نسخة جديدة فوق القديمة لتحتفظ بالسجل.',
            'شارك النسخة مع العميل حين تصبح جاهزة للمراجعة.',
          ],
        },
        { kind: 'tip', text: 'اطلب من العميل قرارًا واحدًا لكل نسخة: الموافقة أو طلب تعديلات.' },
      ],
      keywords: ['رفع', 'مستندات', 'نسخ', 'مرفقات'],
    },
  },
  {
    slug: 'connect-drive-onedrive',
    category: 'files',
    minutes: 3,
    related: ['upload-and-share-files', 'sessions-and-devices'],
    en: {
      title: 'Connect Google Drive or OneDrive',
      summary: 'Store project files in your own cloud storage and work with them from TManage.',
      body: [
        {
          kind: 'p',
          text: 'Files stay in your Google Drive or OneDrive. TManage keeps the link, the versions and the comments.',
        },
        {
          kind: 'steps',
          items: [
            'An owner or admin opens Settings and then Storage.',
            'Choose Google Drive or OneDrive and sign in to it.',
            'Pick the folder TManage may use.',
            'New uploads now go to that folder.',
          ],
        },
        { kind: 'tip', text: 'Disconnecting storage never deletes files from your drive.' },
      ],
      keywords: ['google drive', 'onedrive', 'cloud', 'storage', 'integration'],
    },
    ar: {
      title: 'اربط Google Drive أو OneDrive',
      summary: 'خزّن ملفات المشاريع في مساحتك السحابية واعمل عليها من TManage.',
      body: [
        {
          kind: 'p',
          text: 'تبقى الملفات في Google Drive أو OneDrive الخاص بك، ويحتفظ TManage بالرابط والنسخ والتعليقات.',
        },
        {
          kind: 'steps',
          items: [
            'يفتح المالك أو المسؤول «الإعدادات» ثم «التخزين».',
            'اختر Google Drive أو OneDrive وسجّل الدخول إليه.',
            'حدّد المجلد الذي يمكن لـ TManage استخدامه.',
            'تذهب الملفات المرفوعة الجديدة إلى ذلك المجلد.',
          ],
        },
        { kind: 'tip', text: 'فصل التخزين لا يحذف أي ملفات من مساحتك السحابية.' },
      ],
      keywords: ['جوجل درايف', 'ون درايف', 'سحابة', 'تخزين', 'ربط'],
    },
  },
  {
    slug: 'log-time-timesheets',
    category: 'time-money',
    minutes: 3,
    related: ['invoices-and-expenses', 'create-and-assign-tasks'],
    en: {
      title: 'Log time and submit timesheets',
      summary: 'Record time against tasks, then send the week for approval.',
      body: [
        {
          kind: 'steps',
          items: [
            'Start the timer on a task, or add time by hand.',
            'Open Finance and then Timesheets to see your week.',
            'Fix any gaps, then choose Submit.',
            'Your manager approves the week or returns it with a note.',
          ],
        },
        { kind: 'tip', text: 'Once a period is locked, approved time can no longer change.' },
      ],
      keywords: ['timer', 'hours', 'timesheet', 'billable'],
    },
    ar: {
      title: 'سجّل الوقت وأرسل الجداول الزمنية',
      summary: 'سجّل الوقت على المهام، ثم أرسل الأسبوع للاعتماد.',
      body: [
        {
          kind: 'steps',
          items: [
            'شغّل المؤقّت على مهمة، أو أضف الوقت يدويًا.',
            'افتح «المالية» ثم «الجداول الزمنية» لترى أسبوعك.',
            'أكمل أي فجوات، ثم اختر «إرسال».',
            'يعتمد مديرك الأسبوع أو يعيده مع ملاحظة.',
          ],
        },
        { kind: 'tip', text: 'بعد إقفال الفترة، لا يمكن تعديل الوقت المعتمد.' },
      ],
      keywords: ['مؤقت', 'ساعات', 'جدول زمني', 'قابل للفوترة'],
    },
  },
  {
    slug: 'invoices-and-expenses',
    category: 'time-money',
    minutes: 3,
    related: ['log-time-timesheets', 'what-clients-see'],
    en: {
      title: 'Invoices and expenses',
      summary: 'Turn approved time and expenses into a client invoice.',
      body: [
        {
          kind: 'steps',
          items: [
            'Record expenses under Finance and then Expenses, with a receipt.',
            'Open Invoices and choose New invoice for a client.',
            'Add approved time and expenses, or fixed lines.',
            'Review the totals and tax, then issue the invoice.',
          ],
        },
        {
          kind: 'tip',
          text: 'Rate cards decide the price of each hour, so set them before you invoice.',
        },
      ],
      keywords: ['billing', 'invoice', 'expense', 'receipt', 'rates'],
    },
    ar: {
      title: 'الفواتير والمصروفات',
      summary: 'حوّل الوقت والمصروفات المعتمدة إلى فاتورة للعميل.',
      body: [
        {
          kind: 'steps',
          items: [
            'سجّل المصروفات من «المالية» ثم «المصروفات»، مع الإيصال.',
            'افتح «الفواتير» واختر «فاتورة جديدة» لعميل.',
            'أضف الوقت والمصروفات المعتمدة، أو بنودًا ثابتة.',
            'راجع المجاميع والضريبة، ثم أصدر الفاتورة.',
          ],
        },
        { kind: 'tip', text: 'جداول الأسعار تحدّد سعر كل ساعة، لذا اضبطها قبل إصدار الفواتير.' },
      ],
      keywords: ['فوترة', 'فاتورة', 'مصروف', 'إيصال', 'أسعار'],
    },
  },
  {
    slug: 'two-step-sign-in',
    category: 'security',
    minutes: 2,
    related: ['sessions-and-devices', 'invite-your-team'],
    en: {
      title: 'Turn on two-step sign-in',
      summary: 'A second step keeps your account safe even if your password leaks.',
      body: [
        {
          kind: 'steps',
          items: [
            'Open your account menu and choose Security.',
            'Choose Turn on two-step sign-in.',
            'Scan the code with an authenticator app and enter the six digits.',
            'Save your recovery codes somewhere safe.',
          ],
        },
        {
          kind: 'tip',
          text: 'Admins can require two-step sign-in for chosen roles in workspace security settings.',
        },
      ],
      keywords: ['2fa', 'mfa', 'authenticator', 'password', 'otp'],
    },
    ar: {
      title: 'فعّل تسجيل الدخول بخطوتين',
      summary: 'الخطوة الثانية تحمي حسابك حتى لو تسرّبت كلمة المرور.',
      body: [
        {
          kind: 'steps',
          items: [
            'افتح قائمة الحساب واختر «الأمان».',
            'اختر «تفعيل تسجيل الدخول بخطوتين».',
            'امسح الرمز بتطبيق مصادقة وأدخل الأرقام الستة.',
            'احفظ رموز الاسترداد في مكان آمن.',
          ],
        },
        {
          kind: 'tip',
          text: 'يمكن للمسؤولين فرض تسجيل الدخول بخطوتين على أدوار محدّدة من إعدادات أمان مساحة العمل.',
        },
      ],
      keywords: ['المصادقة الثنائية', 'تطبيق مصادقة', 'كلمة المرور', 'رمز'],
    },
  },
  {
    slug: 'sessions-and-devices',
    category: 'security',
    minutes: 2,
    related: ['two-step-sign-in', 'connect-drive-onedrive'],
    en: {
      title: 'Review sessions and sign out devices',
      summary: 'See where your account is signed in and end any session you do not recognise.',
      body: [
        {
          kind: 'steps',
          items: [
            'Open your account menu and choose Sessions.',
            'Check each device, browser and place.',
            'Choose Sign out on any session you do not recognise.',
            'Change your password if something looks wrong.',
          ],
        },
        {
          kind: 'tip',
          text: 'Admins can see and end sessions for the whole workspace under Admin and then Sessions.',
        },
      ],
      keywords: ['logout', 'devices', 'login history', 'suspicious'],
    },
    ar: {
      title: 'راجع الجلسات وسجّل خروج الأجهزة',
      summary: 'اعرف أين سُجّل الدخول إلى حسابك، وأنهِ أي جلسة لا تعرفها.',
      body: [
        {
          kind: 'steps',
          items: [
            'افتح قائمة الحساب واختر «الجلسات».',
            'تحقّق من كل جهاز ومتصفح وموقع.',
            'اختر «تسجيل الخروج» لأي جلسة لا تعرفها.',
            'غيّر كلمة المرور إذا بدا شيء غير طبيعي.',
          ],
        },
        {
          kind: 'tip',
          text: 'يمكن للمسؤولين رؤية جلسات مساحة العمل كلها وإنهاؤها من «الإدارة» ثم «الجلسات».',
        },
      ],
      keywords: ['تسجيل الخروج', 'أجهزة', 'سجل الدخول', 'مشبوه'],
    },
  },
];

const BY_SLUG: ReadonlyMap<string, HelpArticle> = new Map(HELP_ARTICLES.map((a) => [a.slug, a]));

export function findHelpArticle(slug: string): HelpArticle | undefined {
  return BY_SLUG.get(slug);
}

export function findHelpCategory(id: HelpCategoryId): HelpCategory {
  const found = HELP_CATEGORIES.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown help category ${id}`);
  return found;
}

export function articlesIn(category: HelpCategoryId): HelpArticle[] {
  return HELP_ARTICLES.filter((a) => a.category === category);
}

/** The English path of the help index or one article; Arabic pages prefix `/ar`. */
export function helpHref(slug?: string, language: HelpLanguage = 'en'): string {
  const path = slug ? `/help/${slug}` : '/help';
  return language === 'ar' ? `/ar${path}` : path;
}
