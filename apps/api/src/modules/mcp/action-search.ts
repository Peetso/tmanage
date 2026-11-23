/**
 * The ranking behind `tmanage_find_actions` (the in-app AI and the external MCP share it).
 *
 * 2026-11-23 live: "create a new project" found no `projects.create`, because every query word,
 * "a" and "new" included, had to appear in the action's text. The model then told the member the
 * action did not exist. Now the query is reduced to its meaningful words, each word is matched
 * with its common synonyms and a plural/singular fold, and the actions are ranked by how many
 * words they match (the id and title count more than the description). An action that matches no
 * word is never returned; one that matches some words is, so a near miss still reaches the model.
 */

/** A catalogue entry as the search reads it. */
export interface SearchableAction {
  readonly opId: string;
  readonly title: string;
  readonly description: string;
}

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
]);

/** Verbs and nouns members use, mapped to the words the catalogue is written in. */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  create: ['create', 'add', 'new', 'make', 'start', 'open'],
  add: ['create', 'add', 'new', 'make'],
  make: ['create', 'add', 'make'],
  new: ['create', 'add', 'new'],
  start: ['start', 'create'],
  open: ['open', 'create'],
  delete: ['delete', 'remove', 'archive', 'revoke'],
  remove: ['delete', 'remove', 'archive', 'revoke'],
  archive: ['archive', 'delete', 'remove'],
  update: ['update', 'change', 'edit', 'set', 'rename', 'move'],
  change: ['update', 'change', 'edit', 'set'],
  edit: ['update', 'change', 'edit', 'set'],
  set: ['set', 'update', 'change'],
  rename: ['rename', 'update', 'name'],
  assign: ['assign', 'assignee', 'set'],
  invite: ['invite', 'invitation', 'invitations'],
  list: ['list', 'show', 'find', 'get'],
  show: ['list', 'show', 'get'],
  find: ['list', 'find', 'search', 'get'],
  search: ['search', 'find', 'list'],
  task: ['task', 'work', 'item', 'work_items'],
  todo: ['task', 'work', 'item'],
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
  time: ['time', 'timer', 'timesheet', 'hours'],
  hour: ['time', 'timer', 'timesheet', 'hours'],
  doc: ['document', 'documents', 'doc', 'docs'],
  document: ['document', 'documents', 'doc'],
  file: ['file', 'files', 'upload'],
  meeting: ['meeting', 'meetings', 'calendar', 'event'],
  message: ['message', 'messages', 'chat', 'post'],
  comment: ['comment', 'comments', 'reply'],
};

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
  'start',
  'open',
  'delete',
  'remove',
  'archive',
  'update',
  'change',
  'edit',
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
  start: ['create', 'start'],
  open: ['create', 'open', 'get'],
  delete: ['delete', 'remove', 'archive', 'revoke'],
  remove: ['delete', 'remove', 'archive', 'revoke'],
  archive: ['archive', 'delete'],
  update: ['update', 'set', 'patch'],
  change: ['update', 'set', 'patch'],
  edit: ['update', 'set', 'patch'],
  set: ['set', 'update'],
  rename: ['update', 'set'],
  assign: ['update', 'set', 'add', 'create'],
  invite: ['create'],
  list: ['list', 'get', 'mine'],
  show: ['list', 'get'],
  find: ['list', 'get', 'search'],
  search: ['search', 'list'],
};

interface QueryTerm {
  /** The member's word and its singular. */
  readonly own: readonly string[];
  /** The own words plus their synonyms. */
  readonly any: readonly string[];
  /** For a verb word: the id endings that do it. */
  readonly verbIds: readonly string[] | null;
}

function queryTerms(query: string): QueryTerm[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w !== '');
  const meaningful = words.filter((w) => !STOP_WORDS.has(w));
  // A query of stop words only ("new") still searches with what it has.
  const kept = meaningful.length > 0 ? meaningful : words;
  return kept.map((word) => {
    const base = singular(word);
    const own = [...new Set([word, base])];
    return {
      own,
      any: [...new Set([...own, ...(SYNONYMS[base] ?? []), ...(SYNONYMS[word] ?? [])])],
      verbIds: VERBS.has(base) ? (VERB_IDS[base] ?? [base]) : null,
    };
  });
}

/** The actions for a plain-words query, best first; never an action that matches no word. */
export function rankActions<T extends SearchableAction>(
  actions: Iterable<T>,
  query: string,
  limit: number,
): T[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const scored: { action: T; score: number }[] = [];
  for (const action of actions) {
    const head = `${action.opId.replace(/[._]/g, ' ')} ${action.title}`.toLowerCase();
    const body = action.description.toLowerCase();
    const idParts = action.opId.split('.');
    const verb = idParts[idParts.length - 1] ?? '';
    const resource = idParts.slice(0, -1).join('_').split('_');
    let score = 0;
    let matched = 0;
    for (const term of terms) {
      // What to do decides first: the id's own verb doing it counts most, another verb counts against.
      if (term.verbIds !== null) score += term.verbIds.includes(verb) ? 8 : -5;
      // What it is done to: the thing named in the id.
      else if (term.any.some((w) => resource.includes(w) || resource.includes(singular(w))))
        score += 4;
      if (term.own.some((w) => head.includes(w))) {
        // The member's own word (or its singular) in the id or title.
        score += 5;
        matched += 1;
      } else if (term.any.some((w) => head.includes(w))) {
        score += 3;
        matched += 1;
      } else if (term.any.some((w) => body.includes(w))) {
        score += 1;
        matched += 1;
      }
    }
    if (matched === 0) continue;
    // Every word matched: well ahead of a partial match. A shorter id is the more general action.
    if (matched === terms.length) score += 10;
    scored.push({ action, score: score - action.opId.length / 1000 });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.action);
}
