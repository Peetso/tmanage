import type { HelpArticle } from './help-articles';

/**
 * Plan 62-20 — the Help centre article for TManage AI, the assistant built into the workspace
 * (plan 62). Every line matches what the product does: the server decides the price and what a
 * member may see (62-03, 62-05), changes wait for Confirm (62-15) with Undo while the server allows it, free help is 20 a member a day,
 * conversations are kept 30 days unless the owner changes it (62-13), Business Memory saves only
 * approved facts (62-26), and voice uses the browser's own speech features (62-16). English and
 * Modern Standard Arabic side by side, as in `help-articles.ts`.
 */
export const TMANAGE_AI_HELP_ARTICLES: readonly HelpArticle[] = [
  {
    slug: 'tmanage-ai',
    category: 'getting-started',
    minutes: 3,
    related: ['connect-an-ai-assistant', 'ai-recipes', 'invite-your-team'],
    en: {
      title: 'Ask TManage AI',
      summary:
        'Ask about your work, have it suggest changes you confirm, and see what each answer costs.',
      body: [
        {
          kind: 'p',
          text: 'TManage AI is the assistant inside your workspace. It answers from the projects, tasks and files you can already open, and it never sees more than you do. It is in testing, and your company’s owner decides whether it is on.',
        },
        { kind: 'p', text: 'To ask a question:' },
        {
          kind: 'steps',
          items: [
            'Choose Let AI do the job at the top of the screen, then TManage AI.',
            'Type your question, or tap the microphone and speak.',
            'Read the answer. The line under it shows the credits it used.',
          ],
        },
        {
          kind: 'p',
          text: 'Changes: when you ask for a change, such as moving a due date, TManage AI shows a card with each change first. Nothing changes until you choose Confirm. For an amount of money you type the amount again, and deleting asks you once more. Most changes can be undone for a short time afterwards; the result line says until when.',
        },
        {
          kind: 'p',
          text: 'Credits: your workspace gets AI credits each month. A larger task shows its cost before it starts, so you can continue or cancel. Questions about how to use TManage are free, up to 20 a day for each member. The owner sees the month’s use under Admin, then AI, then Usage.',
        },
        {
          kind: 'p',
          text: 'Voice: tap the microphone, speak, then tap it again. The words appear in the box for you to check and edit; nothing is sent until you choose Send. The speaker button reads an answer aloud. Voice uses your browser’s own speech features, so it is not available in every browser.',
        },
        {
          kind: 'p',
          text: 'Business Memory: the facts TManage AI should know about your company, such as your working days or how you name projects. It suggests facts; they are used only after someone who manages AI approves them under Admin, then AI, then Business Memory.',
        },
        {
          kind: 'tip',
          text: 'Your conversations are private to you. Find them under Past conversations; they are kept for 30 days unless your owner sets another period, and you can delete one at any time.',
        },
      ],
      keywords: [
        'AI',
        'assistant',
        'chat',
        'copilot',
        'credits',
        'voice',
        'microphone',
        'read aloud',
        'Business Memory',
      ],
    },
    ar: {
      title: 'اسأل TManage AI',
      summary: 'اسأل عن عملك، ودعه يقترح تغييرات تؤكدها بنفسك، واطّلع على تكلفة كل إجابة.',
      body: [
        {
          kind: 'p',
          text: 'TManage AI هو المساعد المدمج في مساحة عملك. يجيب من المشاريع والمهام والملفات التي يمكنك فتحها أصلًا، ولا يرى أكثر مما تراه. وهو في مرحلة التجربة، ويقرر مالك الشركة تفعيله.',
        },
        { kind: 'p', text: 'لطرح سؤال:' },
        {
          kind: 'steps',
          items: [
            'اختر «اترك المهمة للذكاء الاصطناعي» أعلى الشاشة، ثم TManage AI.',
            'اكتب سؤالك، أو اضغط على الميكروفون وتحدّث.',
            'اقرأ الإجابة. يبيّن السطر أسفلها الأرصدة التي استخدمتها.',
          ],
        },
        {
          kind: 'p',
          text: 'التغييرات: عندما تطلب تغييرًا، مثل نقل موعد تسليم، يعرض TManage AI أولًا بطاقة بكل تغيير. لا يتغير شيء حتى تختار «تأكيد». في المبالغ المالية تكتب المبلغ مرة أخرى، ويطلب الحذف تأكيدًا إضافيًا. ويمكن التراجع عن معظم التغييرات لمدة قصيرة بعد تنفيذها، ويبيّن سطر النتيجة آخر موعد لذلك.',
        },
        {
          kind: 'p',
          text: 'الأرصدة: تحصل مساحة عملك على أرصدة ذكاء اصطناعي كل شهر. المهمة الأكبر تعرض تكلفتها قبل البدء، فتختار المتابعة أو الإلغاء. أسئلة طريقة استخدام TManage مجانية، حتى 20 سؤالًا يوميًا لكل عضو. ويرى المالك استخدام الشهر في «الإدارة» ثم «الذكاء الاصطناعي» ثم «الاستخدام».',
        },
        {
          kind: 'p',
          text: 'الصوت: اضغط على الميكروفون وتحدّث، ثم اضغط عليه مرة أخرى. تظهر الكلمات في المربع لتراجعها وتعدّلها، ولا يُرسل شيء حتى تختار «إرسال». ويقرأ زر السماعة الإجابة بصوت مسموع. يعتمد الصوت على خصائص الكلام في متصفحك، لذا قد لا يتوفر في كل المتصفحات.',
        },
        {
          kind: 'p',
          text: 'ذاكرة الأعمال: الحقائق التي ينبغي أن يعرفها TManage AI عن شركتك، مثل أيام العمل أو طريقة تسمية المشاريع. يقترح المساعد الحقائق، ولا تُستخدم إلا بعد أن يوافق عليها من يدير الذكاء الاصطناعي في «الإدارة» ثم «الذكاء الاصطناعي» ثم «ذاكرة الأعمال».',
        },
        {
          kind: 'tip',
          text: 'محادثاتك خاصة بك. تجدها في «المحادثات السابقة»، وتُحفظ 30 يومًا ما لم يحدد المالك مدة أخرى، ويمكنك حذف أي محادثة في أي وقت.',
        },
      ],
      keywords: [
        'ذكاء اصطناعي',
        'مساعد',
        'محادثة',
        'أرصدة',
        'صوت',
        'ميكروفون',
        'قراءة بصوت مسموع',
        'ذاكرة الأعمال',
      ],
    },
  },
];
