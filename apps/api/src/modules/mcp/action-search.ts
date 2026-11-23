/**
 * The ranking behind `tmanage_find_actions` (the in-app AI and the external MCP share it).
 *
 * 2026-11-23 live: "create a new project" found no `projects.create`, because every query word,
 * "a" and "new" included, had to appear in the action's text. The model then told the member the
 * action did not exist. Now the query is reduced to its meaningful words, each word is matched
 * with its common synonyms and a plural/singular fold, and the actions are ranked by how many
 * words they match (the id and title count more than the description). An action that matches no
 * word is never returned; one that matches some words is, so a near miss still reaches the model.
 *
 * Fix lane A, 2026-11-23 (`work/pass-2026-11-23/AI-ACTIONS-LIVE-TEST.md` §8 fixes 5 and 8):
 *
 * - **Arabic.** Every Arabic query found nothing. A query is now normalised the way Arabic search
 *   is normally folded (tashkeel and tatweel removed; أ/إ/آ/ٱ → ا, ة → ه, ى → ي), the clitics
 *   و / ال / بال / لل are tried off, and Modern Standard and Egyptian words for the main verbs and
 *   nouns map to the English words the catalogue is written in. `descriptionAr` is searched too.
 * - **Ranking.** "create a task" put `work_items.subtasks.create` first. The area's main action now
 *   gets a boost when the query names the area's noun, and a sub-resource the query does not name
 *   (subtasks, forms, tags, direct, …) counts against the action, as do the client portal and the
 *   platform areas unless the query says "portal" or "platform".
 */

/** A catalogue entry as the search reads it. */
export interface SearchableAction {
  readonly opId: string;
  readonly title: string;
  readonly description: string;
  /** The Arabic description, when the op has one (R18-b). */
  readonly descriptionAr?: string;
}

/**
 * Arabic folded for matching: diacritics (U+064B–U+065F, the dagger alif U+0670) and the tatweel
 * (U+0640) removed; the alif forms أ إ آ ٱ → ا, taa marbuta ة → ه, alif maqsura ى → ي. Latin text
 * is only lower-cased.
 */
export function normalizeArabic(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

const ARABIC = /[؀-ۿ]/;

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'for',
  'of',
  'in',
  'on',
  'at',
  'by',
  'with',
  'from',
  'into',
  'and',
  'or',
  'my',
  'our',
  'your',
  'me',
  'i',
  'we',
  'it',
  'this',
  'that',
  'some',
  'one',
  'please',
  'can',
  'you',
  'want',
  'need',
  'is',
  'be',
  'do',
  'new',
  'all',
  'someone',
  'person',
  // Arabic (folded): "I want", "please", "can", prepositions, "new", "this", "his name", …
  ...[
    'عايز',
    'عايزه',
    'عايزك',
    'عاوز',
    'أريد',
    'اريد',
    'ممكن',
    'لو',
    'سمحت',
    'من',
    'في',
    'فى',
    'على',
    'علي',
    'إلى',
    'الى',
    'ل',
    'لـ',
    'جديد',
    'جديدة',
    'أنا',
    'انا',
    'لي',
    'ليا',
    'دي',
    'ده',
    'دا',
    'كل',
    'عن',
    'مع',
    'يا',
    'اسم',
    'اسمه',
    'اسمها',
    'هذا',
    'هذه',
    'التي',
    'الذي',
    'اللي',
    'و',
    'أو',
    'او',
    'بتاع',
    'بتاعي',
    'بتاعتي',
  ].map(normalizeArabic),
]);

/** Verbs and nouns members use, mapped to the words the catalogue is written in. */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  create: ['create', 'add', 'new', 'make', 'start', 'open'],
  add: ['create', 'add', 'new', 'make'],
  make: ['create', 'add', 'make'],
  new: ['create', 'add', 'new'],
  write: ['create', 'write', 'draft'],
  start: ['start', 'create'],
  open: ['open', 'create'],
  stop: ['stop', 'end'],
  send: ['send', 'post', 'create', 'message'],
  post: ['post', 'send', 'create'],
  delete: ['delete', 'remove', 'archive', 'revoke'],
  remove: ['delete', 'remove', 'archive', 'revoke'],
  archive: ['archive', 'delete', 'remove'],
  update: ['update', 'change', 'edit', 'set', 'rename', 'move'],
  change: ['update', 'change', 'edit', 'set'],
  edit: ['update', 'change', 'edit', 'set'],
  move: ['move', 'transition', 'update', 'status'],
  set: ['set', 'update', 'change'],
  rename: ['rename', 'update', 'name'],
  assign: ['assign', 'assignee', 'doer', 'doers', 'people', 'set'],
  invite: ['invite', 'invitation', 'invitations'],
  list: ['list', 'show', 'find', 'get'],
  show: ['list', 'show', 'get'],
  find: ['list', 'find', 'search', 'get'],
  search: ['search', 'find', 'list'],
  task: ['task', 'work', 'item', 'work_items'],
  todo: ['task', 'work', 'item'],
  project: ['project', 'projects'],
  client: ['client', 'client_organizations', 'company', 'organization'],
  company: ['client', 'company', 'organization', 'client_organizations'],
  customer: ['client', 'company'],
  employee: ['member', 'person', 'people', 'teammate'],
  teammate: ['member', 'person', 'people', 'teammate'],
  member: ['member', 'members', 'person', 'people'],
  role: ['role', 'roles', 'permission', 'permissions', 'access'],
  permission: ['role', 'roles', 'permission', 'permissions', 'access', 'capability'],
  bill: ['invoice', 'billing', 'bill'],
  invoice: ['invoice', 'invoices', 'billing'],
  quote: ['quote', 'quotes', 'estimate'],
  expense: ['expense', 'expenses'],
  time: ['time', 'timer', 'timesheet', 'hours'],
  timer: ['timer', 'time'],
  hour: ['time', 'timer', 'timesheet', 'hours'],
  doc: ['document', 'documents', 'doc', 'docs'],
  document: ['document', 'documents', 'doc'],
  file: ['file', 'files', 'upload'],
  meeting: ['meeting', 'meetings', 'calendar', 'event'],
  conversation: ['conversation', 'conversations', 'chat', 'channel', 'message'],
  chat: ['chat', 'conversation', 'conversations', 'message', 'messages', 'channel'],
  channel: ['channel', 'conversation', 'conversations', 'chat'],
  message: ['message', 'messages', 'chat', 'post'],
  comment: ['comment', 'comments', 'reply'],
  automation: ['automation', 'automations', 'workflow'],
  rule: ['rule', 'rules', 'template', 'templates', 'automation'],
  team: ['team', 'teams'],
};

/**
 * Arabic (Modern Standard and Egyptian) words for the main verbs and nouns, mapped to the English
 * catalogue words. Keys are folded with {@link normalizeArabic} when the table is built, so they
 * are written here as people type them.
 */
const ARABIC_WORDS: Readonly<Record<string, readonly string[]>> = foldKeys({
  // create
  اعمل: ['create'],
  اعملي: ['create'],
  اعمللي: ['create'],
  عمل: ['create'],
  أنشئ: ['create'],
  انشئ: ['create'],
  إنشاء: ['create'],
  أنشأ: ['create'],
  ضيف: ['add'],
  ضيفي: ['add'],
  أضف: ['add'],
  اضف: ['add'],
  إضافة: ['add'],
  اضافة: ['add'],
  زود: ['add'],
  سجل: ['create', 'log'],
  اكتب: ['write'],
  // delete
  امسح: ['delete'],
  مسح: ['delete'],
  احذف: ['delete'],
  حذف: ['delete'],
  شيل: ['remove'],
  الغي: ['cancel', 'delete'],
  ألغي: ['cancel', 'delete'],
  الغاء: ['cancel', 'delete'],
  // update
  عدل: ['update'],
  تعديل: ['update'],
  غير: ['change'],
  تغيير: ['change'],
  حدث: ['update'],
  تحديث: ['update'],
  انقل: ['move'],
  نقل: ['move'],
  // invite
  انفايت: ['invite'],
  دعوة: ['invite'],
  ادعي: ['invite'],
  ادعو: ['invite'],
  اعزم: ['invite'],
  // assign
  كلف: ['assign'],
  اسند: ['assign'],
  أسند: ['assign'],
  عين: ['assign'],
  // list / show / find
  اعرض: ['show'],
  عرض: ['show'],
  وريني: ['show'],
  ورني: ['show'],
  هات: ['show'],
  اظهر: ['show'],
  قائمة: ['list'],
  لستة: ['list'],
  ابحث: ['search'],
  بحث: ['search'],
  دورلي: ['search'],
  // start / stop / send
  ابدأ: ['start'],
  ابدا: ['start'],
  شغل: ['start'],
  وقف: ['stop'],
  أوقف: ['stop'],
  ابعت: ['send'],
  ابعث: ['send'],
  أرسل: ['send'],
  ارسل: ['send'],
  // nouns
  مهمة: ['task'],
  مهمه: ['task'],
  مهام: ['task'],
  تاسك: ['task'],
  تاسكات: ['task'],
  مشروع: ['project'],
  مشاريع: ['project'],
  مشروعات: ['project'],
  بروجكت: ['project'],
  بروجيكت: ['project'],
  عميل: ['client'],
  عملاء: ['client'],
  كلاينت: ['client'],
  شركة: ['client'],
  موظف: ['employee'],
  موظفين: ['employee'],
  عضو: ['member'],
  أعضاء: ['member'],
  فاتورة: ['invoice'],
  فواتير: ['invoice'],
  انفويس: ['invoice'],
  تايمر: ['timer'],
  وقت: ['time'],
  مؤقت: ['timer'],
  اجتماع: ['meeting'],
  اجتماعات: ['meeting'],
  ميتنج: ['meeting'],
  ميتينج: ['meeting'],
  قناة: ['channel'],
  شات: ['chat'],
  محادثة: ['conversation'],
  رسالة: ['message'],
  مستند: ['document'],
  مستندات: ['document'],
  دوكيومنت: ['document'],
  ملف: ['file'],
  ملفات: ['file'],
  صلاحية: ['permission'],
  صلاحيات: ['permission'],
  دور: ['role'],
  أدوار: ['role'],
  تعليق: ['comment'],
  مصروف: ['expense'],
  مصاريف: ['expense'],
  فريق: ['team'],
  أتمتة: ['automation'],
  قاعدة: ['rule'],
});

function foldKeys(
  table: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(table)) {
    const folded = normalizeArabic(key);
    out[folded] = [...new Set([...(out[folded] ?? []), ...value])];
  }
  return out;
}

/** The forms of one folded Arabic word to look up: as typed, without و, without ال/بال/لل/…. */
function arabicForms(word: string): string[] {
  const forms = new Set([word]);
  const bases = word.length > 3 && word.startsWith('و') ? [word, word.slice(1)] : [word];
  for (const base of bases) {
    forms.add(base);
    for (const prefix of ['بال', 'فال', 'كال', 'وال', 'لل', 'ال']) {
      if (base.startsWith(prefix) && base.length - prefix.length >= 2) {
        forms.add(base.slice(prefix.length));
      }
    }
  }
  // An attached pronoun ("اعمله", "مهمتي"): try the word without it (ت before it was a ة).
  for (const form of [...forms]) {
    for (const suffix of ['ها', 'هم', 'نا', 'ه', 'ي', 'ك']) {
      if (form.endsWith(suffix) && form.length - suffix.length >= 3) {
        const stem = form.slice(0, -suffix.length);
        forms.add(stem);
        if (stem.endsWith('ت')) forms.add(`${stem.slice(0, -1)}ه`);
      }
    }
  }
  return [...forms];
}

/** The same word in singular form ("projects" → "project", "companies" → "company"). */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Words that name what to do; the action id's last part is its verb (`projects.create`). */
const VERBS = new Set([
  'create',
  'add',
  'make',
  'new',
  'write',
  'start',
  'open',
  'stop',
  'send',
  'post',
  'delete',
  'remove',
  'archive',
  'cancel',
  'update',
  'change',
  'edit',
  'move',
  'set',
  'rename',
  'assign',
  'invite',
  'list',
  'show',
  'find',
  'search',
]);

/** The verb parts an action id may end with, for each verb word. */
const VERB_IDS: Readonly<Record<string, readonly string[]>> = {
  create: ['create', 'add', 'set'],
  add: ['create', 'add', 'set'],
  make: ['create', 'add'],
  new: ['create', 'add'],
  write: ['create', 'update'],
  start: ['create', 'start'],
  open: ['create', 'open', 'get'],
  stop: ['stop'],
  send: ['create', 'send', 'post'],
  post: ['create', 'send', 'post'],
  delete: ['delete', 'remove', 'archive', 'revoke'],
  remove: ['delete', 'remove', 'archive', 'revoke'],
  archive: ['archive', 'delete'],
  cancel: ['cancel', 'delete', 'revoke', 'void', 'discard'],
  update: ['update', 'set', 'patch'],
  change: ['update', 'set', 'patch'],
  edit: ['update', 'set', 'patch'],
  move: ['create', 'update', 'set', 'move'],
  set: ['set', 'update'],
  rename: ['update', 'set'],
  assign: ['set', 'update', 'add', 'create'],
  invite: ['create'],
  list: ['list', 'get', 'mine'],
  show: ['list', 'get'],
  find: ['list', 'get', 'search'],
  search: ['search', 'list'],
};

/**
 * The main area of each common noun: the first part of the id of the action a member means when
 * they say "a task", "a client", "a chat message" without naming anything more specific.
 */
const PRIMARY_AREAS: Readonly<Record<string, readonly string[]>> = {
  task: ['work_items'],
  todo: ['work_items'],
  project: ['projects'],
  client: ['client_organizations'],
  company: ['client_organizations'],
  customer: ['client_organizations'],
  document: ['documents'],
  doc: ['documents'],
  conversation: ['conversations'],
  chat: ['conversations'],
  channel: ['conversations'],
  message: ['conversations'],
  automation: ['automations'],
  rule: ['automations'],
  invoice: ['client_invoices'],
  meeting: ['meetings'],
  timer: ['time'],
  quote: ['quotes'],
  employee: ['invitations', 'members'],
  member: ['members', 'invitations'],
  team: ['people'],
};

/** Areas a plain query does not mean unless it names them. */
const NAMED_ONLY_AREAS: Readonly<Record<string, string>> = {
  portal: 'portal',
  platform: 'platform',
};

interface QueryTerm {
  /** The member's word, its singular, and (for an Arabic word) its forms and English words. */
  readonly own: readonly string[];
  /** The own words plus their synonyms. */
  readonly any: readonly string[];
  /** For a verb word: the id endings that do it. */
  readonly verbIds: readonly string[] | null;
  /** For a common noun: the area ids of its main action. */
  readonly areas: readonly string[];
}

function termFor(word: string): QueryTerm | null {
  const english: string[] = [];
  let own: string[];
  if (ARABIC.test(word)) {
    const forms = arabicForms(word);
    if (forms.some((f) => STOP_WORDS.has(f))) return null;
    for (const form of forms) english.push(...(ARABIC_WORDS[form] ?? []));
    own = [...new Set([...forms, ...english])];
  } else {
    if (STOP_WORDS.has(word)) return null;
    const base = singular(word);
    english.push(word, base);
    own = [...new Set([word, base])];
  }
  const any = new Set(own);
  const verbIds = new Set<string>();
  const areas = new Set<string>();
  let isVerb = false;
  for (const w of new Set(english)) {
    for (const s of SYNONYMS[w] ?? []) any.add(s);
    if (VERBS.has(w)) {
      isVerb = true;
      for (const v of VERB_IDS[w] ?? [w]) verbIds.add(v);
    }
    for (const a of PRIMARY_AREAS[w] ?? []) areas.add(a);
  }
  return { own, any: [...any], verbIds: isVerb ? [...verbIds] : null, areas: [...areas] };
}

function queryTerms(query: string): QueryTerm[] {
  const words = normalizeArabic(query)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w !== '');
  const terms = words.map(termFor).filter((t): t is QueryTerm => t !== null);
  if (terms.length > 0) return terms;
  // A query of stop words only ("new") still searches with what it has.
  return words.map((w) => ({ own: [w], any: [w], verbIds: null, areas: [] }));
}

/** The actions for a plain-words query, best first; never an action that matches no word. */
export function rankActions<T extends SearchableAction>(
  actions: Iterable<T>,
  query: string,
  limit: number,
): T[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const named = new Set(terms.flatMap((t) => t.any));
  const scored: { action: T; score: number }[] = [];
  for (const action of actions) {
    const head = `${action.opId.replace(/[._]/g, ' ')} ${action.title}`.toLowerCase();
    const body = normalizeArabic(`${action.description} ${action.descriptionAr ?? ''}`);
    const idParts = action.opId.split('.');
    const verb = idParts[idParts.length - 1] ?? '';
    const area = idParts[0] ?? '';
    const resource = idParts.slice(0, -1).join('_').split('_');
    let score = 0;
    let matched = 0;
    let inHead = 0;
    let primary = false;
    for (const term of terms) {
      // What to do decides first: the id's own verb doing it counts most, another verb counts against.
      if (term.verbIds !== null) score += term.verbIds.includes(verb) ? 8 : -5;
      // What it is done to: the thing named in the id.
      else if (term.any.some((w) => resource.includes(w) || resource.includes(singular(w))))
        score += 4;
      if (term.areas.includes(area)) primary = true;
      if (term.own.some((w) => head.includes(w))) {
        // The member's own word (or its singular) in the id or title.
        score += 5;
        matched += 1;
        inHead += 1;
      } else if (term.any.some((w) => head.includes(w))) {
        score += 3;
        matched += 1;
        inHead += 1;
      } else if (term.any.some((w) => body.includes(w))) {
        score += 1;
        matched += 1;
      }
    }
    if (matched === 0) continue;
    // Every word matched: well ahead of a partial match; less so when some only in the description.
    if (matched === terms.length) score += inHead === terms.length ? 10 : 4;
    // The area's main action for the noun the member used ("a task" → work_items.*).
    if (primary) score += 6;
    // A sub-resource the query does not name (`work_items.subtasks.create` for "create a task").
    // A verb inside the sub-resource's name ("set" in `stage_set`) does not name it: "assign a task"
    // reaches "set" through the verb's synonyms, and must not excuse `work_items.stage_set.*`.
    for (const sub of idParts.slice(1, -1)) {
      const words = sub.split('_').filter((w) => !VERBS.has(w));
      if (!words.some((w) => named.has(w) || named.has(singular(w)))) score -= 4;
    }
    const onlyWhenNamed = NAMED_ONLY_AREAS[area];
    if (onlyWhenNamed !== undefined && !named.has(onlyWhenNamed)) score -= 6;
    // A shorter id is the more general action.
    scored.push({ action, score: score - action.opId.length / 1000 });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.action);
}
