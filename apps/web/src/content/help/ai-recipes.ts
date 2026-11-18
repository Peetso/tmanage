import type { HelpArticle, HelpBlock, HelpLanguage } from './help-articles';

/**
 * 55-15p — ready-made requests ("recipes") for an AI assistant connected to TManage over MCP.
 *
 * Each recipe is a Help centre article with one request to copy (a `prompt` block, drawn with a
 * Copy button). Every request only asks for what the TManage MCP server really offers: My day
 * (`home.my_day.list`), work items, projects and the project context resource, the inbox and
 * notifications, search and documents, conversations and their messages, calendar focus blocks and
 * people. Requests that change something tell the assistant to show the result first; actions the
 * server classes as risky wait for the member's approval in TManage whatever the request says.
 * English and Arabic side by side, as in `help-articles.ts`.
 */

const RECIPE_RELATED = ['ai-recipes', 'connect-an-ai-assistant'] as const;

const COPY_LINE: Record<HelpLanguage, string> = {
  en: 'Copy this request and paste it into your assistant.',
  ar: 'انسخ هذا الطلب والصقه في مساعدك.',
};

const COPY_LINE_FILL: Record<HelpLanguage, string> = {
  en: 'Copy this request and paste it into your assistant. Replace the words in square brackets first.',
  ar: 'انسخ هذا الطلب والصقه في مساعدك. استبدل الكلمات بين القوسين المربعين أولًا.',
};

const SAFETY_TIP: Record<HelpLanguage, HelpBlock> = {
  en: {
    kind: 'tip',
    text: 'The assistant can do only what you can do in TManage. Risky actions, such as deleting, wait for your approval under Settings, then AI actions.',
  },
  ar: {
    kind: 'tip',
    text: 'لا يستطيع المساعد إلا ما تستطيعه أنت في TManage. والإجراءات الحساسة، مثل الحذف، تنتظر موافقتك في «الإعدادات» ثم «إجراءات المساعد».',
  },
};

interface RecipeText {
  title: string;
  summary: string;
  what: string;
  prompt: string;
  keywords: readonly string[];
}

function recipe(slug: string, fill: boolean, en: RecipeText, ar: RecipeText): HelpArticle {
  const body = (language: HelpLanguage, text: RecipeText): HelpBlock[] => [
    { kind: 'p', text: text.what },
    { kind: 'p', text: fill ? COPY_LINE_FILL[language] : COPY_LINE[language] },
    { kind: 'prompt', text: text.prompt },
    SAFETY_TIP[language],
  ];
  return {
    slug,
    category: 'getting-started',
    minutes: 1,
    related: RECIPE_RELATED,
    en: { title: en.title, summary: en.summary, body: body('en', en), keywords: en.keywords },
    ar: { title: ar.title, summary: ar.summary, body: body('ar', ar), keywords: ar.keywords },
  };
}

/** The recipes, in the order the hub article lists them. */
export const AI_RECIPES: readonly HelpArticle[] = [
  recipe(
    'ai-recipe-plan-my-week',
    false,
    {
      title: 'AI request: plan my week',
      summary: 'Your assistant reads your work and focus time and drafts a plan for the week.',
      what: 'The assistant reads your work for today, your open tasks and your focus blocks, then proposes an order for the week. It changes nothing.',
      prompt:
        'Using TManage, read my work for today, my open work items and my focus blocks on the calendar. Group them by project, flag anything overdue or due this week, and propose a day-by-day plan for this week. Do not change anything in TManage; just show me the plan.',
      keywords: ['ai', 'assistant', 'prompt', 'recipe', 'week', 'plan', 'schedule'],
    },
    {
      title: 'طلب للمساعد: خطّط لأسبوعي',
      summary: 'يقرأ مساعدك عملك ووقت تركيزك ويقترح خطة للأسبوع.',
      what: 'يقرأ المساعد عملك لليوم ومهامك المفتوحة وفترات التركيز في التقويم، ثم يقترح ترتيبًا للأسبوع. ولا يغيّر شيئًا.',
      prompt:
        'باستخدام TManage، اقرأ عملي لهذا اليوم وبنود العمل المفتوحة وفترات التركيز في التقويم. رتّبها حسب المشروع، ونبّهني إلى كل ما تأخر أو يستحق هذا الأسبوع، واقترح خطة يومًا بيوم لهذا الأسبوع. لا تغيّر شيئًا في TManage، اعرض الخطة فقط.',
      keywords: ['مساعد', 'ذكاء اصطناعي', 'طلب', 'أسبوع', 'خطة', 'جدول'],
    },
  ),
  recipe(
    'ai-recipe-client-update',
    true,
    {
      title: 'AI request: summarise a project for the client',
      summary: 'Your assistant drafts a plain update for a client from the project as it stands.',
      what: 'The assistant reads one project, its open work and its milestones, and drafts an update a client can read. It does not post or send anything.',
      prompt:
        'Using TManage, open the project [project name] with its open work items and milestones. Write a short update for the client: what was done, what comes next and anything we need from them. Use plain words and leave out internal notes. Do not post or send it; show it to me first.',
      keywords: ['ai', 'assistant', 'prompt', 'recipe', 'client', 'status', 'update', 'report'],
    },
    {
      title: 'طلب للمساعد: لخّص مشروعًا للعميل',
      summary: 'يكتب مساعدك تحديثًا واضحًا للعميل من حالة المشروع الحالية.',
      what: 'يقرأ المساعد مشروعًا واحدًا وعمله المفتوح ومراحله، ثم يكتب تحديثًا يفهمه العميل. ولا ينشر شيئًا ولا يرسله.',
      prompt:
        'باستخدام TManage، افتح المشروع [اسم المشروع] مع بنود العمل المفتوحة والمراحل. اكتب تحديثًا قصيرًا للعميل: ما أُنجز، وما التالي، وما نحتاجه منه. استخدم كلمات بسيطة ولا تذكر الملاحظات الداخلية. لا تنشره ولا ترسله، اعرضه عليّ أولًا.',
      keywords: ['مساعد', 'ذكاء اصطناعي', 'طلب', 'عميل', 'تحديث', 'تقرير'],
    },
  ),
  recipe(
    'ai-recipe-sort-inbox',
    false,
    {
      title: 'AI request: sort my inbox',
      summary: 'Your assistant groups your inbox by what needs you and suggests a next step.',
      what: 'The assistant reads your inbox and notifications and sorts them by what needs a reply, a decision or nothing. It replies to nothing.',
      prompt:
        'Using TManage, read my inbox and my notifications. Group them into three lists: needs my reply, needs my decision, and no action. For each one, suggest what I should do in one line. Do not reply or change anything without asking me.',
      keywords: ['ai', 'assistant', 'prompt', 'recipe', 'inbox', 'notifications', 'triage'],
    },
    {
      title: 'طلب للمساعد: رتّب صندوق الوارد',
      summary: 'يرتّب مساعدك صندوق الوارد حسب ما يحتاجك ويقترح الخطوة التالية.',
      what: 'يقرأ المساعد صندوق الوارد والإشعارات، ويرتّبها حسب ما يحتاج ردًا أو قرارًا أو لا شيء. ولا يردّ على أي شيء.',
      prompt:
        'باستخدام TManage، اقرأ صندوق الوارد والإشعارات. قسّمها إلى ثلاث قوائم: يحتاج ردّي، ويحتاج قراري، ولا يحتاج شيئًا. واقترح لكل بند ما يجب أن أفعله في سطر واحد. لا تردّ ولا تغيّر شيئًا دون أن تسألني.',
      keywords: ['مساعد', 'ذكاء اصطناعي', 'طلب', 'صندوق الوارد', 'إشعارات'],
    },
  ),
  recipe(
    'ai-recipe-whats-overdue',
    false,
    {
      title: 'AI request: find what is overdue',
      summary: 'Your assistant lists late and nearly due work across your projects.',
      what: 'The assistant reads your projects and their open work and lists what is late or due soon, most urgent first. It changes nothing.',
      prompt:
        'Using TManage, list my projects and their open work items. Show everything that is overdue or due in the next three days, with the project, the person it is assigned to and the due date, most urgent first. Do not change anything.',
      keywords: ['ai', 'assistant', 'prompt', 'recipe', 'overdue', 'late', 'deadline', 'due'],
    },
    {
      title: 'طلب للمساعد: ما المتأخر؟',
      summary: 'يعرض مساعدك العمل المتأخر والمستحق قريبًا في كل مشاريعك.',
      what: 'يقرأ المساعد مشاريعك وعملها المفتوح، ويعرض ما تأخر أو يستحق قريبًا، الأكثر إلحاحًا أولًا. ولا يغيّر شيئًا.',
      prompt:
        'باستخدام TManage، اعرض مشاريعي وبنود العمل المفتوحة فيها. أظهر كل ما تأخر أو يستحق خلال الأيام الثلاثة القادمة، مع المشروع والشخص المسند إليه وتاريخ الاستحقاق، الأكثر إلحاحًا أولًا. لا تغيّر شيئًا.',
      keywords: ['مساعد', 'ذكاء اصطناعي', 'طلب', 'متأخر', 'موعد', 'استحقاق'],
    },
  ),
  recipe(
    'ai-recipe-notes-to-tasks',
    true,
    {
      title: 'AI request: turn meeting notes into tasks',
      summary: 'Your assistant turns your notes into tasks, after you check the list.',
      what: 'The assistant reads your notes, drafts one task per action point and creates them in a project only after you say yes.',
      prompt:
        'Here are my meeting notes: [paste your notes]. Turn each action point into a TManage task in the project [project name], with a clear title, the person the notes name as owner if there is one, and a due date if the notes give one. Show me the list first and create the tasks only after I say yes.',
      keywords: [
        'ai',
        'assistant',
        'prompt',
        'recipe',
        'meeting',
        'notes',
        'tasks',
        'action items',
      ],
    },
    {
      title: 'طلب للمساعد: حوّل ملاحظات الاجتماع إلى مهام',
      summary: 'يحوّل مساعدك ملاحظاتك إلى مهام بعد أن تراجع القائمة.',
      what: 'يقرأ المساعد ملاحظاتك، ويكتب مهمة لكل بند عمل، ولا ينشئها في المشروع إلا بعد موافقتك.',
      prompt:
        'هذه ملاحظات اجتماعي: [الصق ملاحظاتك]. حوّل كل بند عمل إلى مهمة في TManage داخل المشروع [اسم المشروع]، بعنوان واضح، والشخص المسؤول إن ذكرته الملاحظات، وتاريخ استحقاق إن ورد فيها. اعرض القائمة عليّ أولًا، ولا تنشئ المهام إلا بعد موافقتي.',
      keywords: ['مساعد', 'ذكاء اصطناعي', 'طلب', 'اجتماع', 'ملاحظات', 'مهام'],
    },
  ),
  recipe(
    'ai-recipe-summarise-document',
    true,
    {
      title: 'AI request: find a document and summarise it',
      summary: 'Your assistant finds a document in your workspace and sums it up.',
      what: 'The assistant searches your workspace, opens the best match and summarises it. It does not edit the document.',
      prompt:
        'Using TManage, search for the document about [topic]. Open the best match and summarise it in five bullet points, then list any open questions it raises. Do not edit the document.',
      keywords: ['ai', 'assistant', 'prompt', 'recipe', 'document', 'summary', 'search', 'doc'],
    },
    {
      title: 'طلب للمساعد: ابحث عن مستند ولخّصه',
      summary: 'يجد مساعدك مستندًا في مساحة عملك ويلخّصه.',
      what: 'يبحث المساعد في مساحة عملك، ويفتح أقرب نتيجة ويلخّصها. ولا يعدّل المستند.',
      prompt:
        'باستخدام TManage، ابحث عن المستند الخاص بـ[الموضوع]. افتح أقرب نتيجة ولخّصها في خمس نقاط، ثم اذكر الأسئلة المفتوحة التي يطرحها. لا تعدّل المستند.',
      keywords: ['مساعد', 'ذكاء اصطناعي', 'طلب', 'مستند', 'ملخص', 'بحث'],
    },
  ),
  recipe(
    'ai-recipe-draft-reply',
    true,
    {
      title: 'AI request: draft a reply in a conversation',
      summary: 'Your assistant drafts a reply to a team conversation for you to approve.',
      what: 'The assistant reads the latest messages in one conversation and drafts a reply. It posts only after you approve the wording.',
      prompt:
        'Using TManage, open the conversation [conversation name] and read the latest messages. Draft a short, friendly reply that answers the open questions. Show me the draft and post it only after I approve the wording.',
      keywords: ['ai', 'assistant', 'prompt', 'recipe', 'reply', 'message', 'conversation', 'chat'],
    },
    {
      title: 'طلب للمساعد: اكتب ردًا في محادثة',
      summary: 'يكتب مساعدك مسودة رد في محادثة الفريق لتوافق عليها.',
      what: 'يقرأ المساعد آخر الرسائل في محادثة واحدة ويكتب مسودة رد. ولا ينشره إلا بعد موافقتك على النص.',
      prompt:
        'باستخدام TManage، افتح المحادثة [اسم المحادثة] واقرأ آخر الرسائل. اكتب ردًا قصيرًا ولطيفًا يجيب عن الأسئلة المفتوحة. اعرض المسودة عليّ، ولا تنشرها إلا بعد موافقتي على النص.',
      keywords: ['مساعد', 'ذكاء اصطناعي', 'طلب', 'رد', 'رسالة', 'محادثة'],
    },
  ),
];

/** The hub: what a recipe is, with every recipe as a related link. */
export const AI_RECIPES_HUB: HelpArticle = {
  slug: 'ai-recipes',
  category: 'getting-started',
  minutes: 2,
  related: [...AI_RECIPES.map((r) => r.slug), 'connect-an-ai-assistant'],
  en: {
    title: 'Ready-made requests for your AI assistant',
    summary:
      'Seven requests to copy into Claude, ChatGPT or another assistant connected to TManage.',
    body: [
      {
        kind: 'p',
        text: 'Once your assistant is connected, you can ask it about your work in plain words. Each article below has one request to copy and paste into your assistant.',
      },
      {
        kind: 'steps',
        items: AI_RECIPES.map((r) => r.en.title.replace(/^AI request: /u, '')),
      },
      SAFETY_TIP.en,
    ],
    keywords: ['ai', 'assistant', 'prompts', 'recipes', 'examples', 'mcp', 'claude', 'chatgpt'],
  },
  ar: {
    title: 'طلبات جاهزة لمساعدك الذكي',
    summary: 'سبعة طلبات تنسخها إلى Claude أو ChatGPT أو أي مساعد آخر متصل بـTManage.',
    body: [
      {
        kind: 'p',
        text: 'بعد ربط مساعدك، يمكنك أن تسأله عن عملك بكلمات بسيطة. في كل مقالة أدناه طلب واحد تنسخه وتلصقه في مساعدك.',
      },
      {
        kind: 'steps',
        items: AI_RECIPES.map((r) => r.ar.title.replace(/^طلب للمساعد: /u, '')),
      },
      SAFETY_TIP.ar,
    ],
    keywords: ['مساعد', 'ذكاء اصطناعي', 'طلبات', 'أمثلة', 'كلود', 'شات جي بي تي'],
  },
};

/** The hub first, then the recipes — the order they join `HELP_ARTICLES`. */
export const AI_RECIPE_ARTICLES: readonly HelpArticle[] = [AI_RECIPES_HUB, ...AI_RECIPES];
