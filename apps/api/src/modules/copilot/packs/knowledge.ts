import type { AiToolDefinition } from '../ai-client.js';

/**
 * 62-22 (plan 62 §4.4 levels 1 and 2, §9 row) — the knowledge pack, backend only.
 *
 * - **Level 1, structured finders**: the `files` domain's pack (`PACK_OPS.files` in `index.ts`):
 *   typed reads across clients, projects, files, documents, invoices and quotes, each one registry
 *   op. Exact answers from SQL behind services; the model never builds a filter.
 * - **Level 2, `search_knowledge`**: one strict tool, offered after every domain's pack, that runs
 *   the existing global search (`search.list`, FULLTEXT over `search_index`) as the member. The
 *   search route applies the workspace, project and audience filter before ranking and re-checks
 *   every hit through `search-permission.ts` (the per-hit rule for every kind), so the model only
 *   ever sees hits the member can open. Results are search hits, i.e. text other people wrote:
 *   they are marked untrusted and taint the turn (62-12).
 * - **Citations**: the hits go to the model as numbered sources, each with its in-app path
 *   ({@link recordHref}, the same paths as the web's `resultHref`); in the answer, a link to a
 *   record (`/work/…`, `/projects/…`, …) survives only when that record's id came back from a
 *   tool in this turn ({@link validateRecordLinks}); any other is reduced to its label.
 *
 * Level 3 (file and long-text chunks, RAG) is 62-24.
 */

export const SEARCH_KNOWLEDGE_TOOL = 'search_knowledge';
/** The op `search_knowledge` runs. */
export const SEARCH_KNOWLEDGE_OP = 'search.list';
export const KNOWLEDGE_RESULT_LIMIT = 10;
/** The search route's own query cap (`search.controller.ts` MAX_QUERY_LENGTH). */
export const KNOWLEDGE_QUERY_MAX_CHARS = 200;

/** Strict: every property required (projectId nullable), no extra keys (the ai-client's rule). */
export const KNOWLEDGE_TOOL: AiToolDefinition = Object.freeze({
  name: SEARCH_KNOWLEDGE_TOOL,
  description:
    'Search everything the member can open in this workspace (tasks, projects, documents, ' +
    'meetings, messages, decisions, invoices, quotes, expenses, files) by words. Returns ' +
    'numbered sources with their in-app paths; cite them as links. Use a structured tool ' +
    'instead when one answers the question exactly.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query', 'projectId'],
    properties: {
      query: { type: 'string', description: 'The words to search for.' },
      projectId: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Only this project, or null for the whole workspace.',
      },
    },
  },
}) as AiToolDefinition;

/** The `search.list` arguments of a `search_knowledge` call (the query trimmed to the cap). */
export function knowledgeSearchArgs(input: Readonly<Record<string, unknown>>): {
  readonly q: string;
  readonly projectId?: string;
  readonly limit: number;
} {
  const q = [...String(input['query'] ?? '').trim()].slice(0, KNOWLEDGE_QUERY_MAX_CHARS).join('');
  const projectId = input['projectId'];
  return {
    q,
    ...(typeof projectId === 'string' && projectId !== '' ? { projectId } : {}),
    limit: KNOWLEDGE_RESULT_LIMIT,
  };
}

/**
 * The in-app path of a record, or `null` for a kind with no page of its own. Mirrors the web's
 * `resultHref` (`apps/web/src/components/shell/command-palette-model.ts`); `knowledge.test.ts`
 * reads that file and fails when the two drift.
 */
export function recordHref(kind: string, id: string): string | null {
  const safe = encodeURIComponent(id);
  switch (kind) {
    case 'work_item':
      return `/work/${safe}`;
    case 'project':
      return `/projects/${safe}`;
    case 'document':
      return `/docs/${safe}`;
    case 'meeting':
      return `/calendar/meetings/${safe}`;
    case 'invoice':
      return `/finance/invoices/${safe}`;
    case 'quote':
      return `/quotes/${safe}`;
    case 'file':
      return `/files/${safe}`;
    default:
      return null;
  }
}

interface Hit {
  readonly kind: string;
  readonly id: string;
  readonly title: string;
  readonly audience: string | null;
  readonly updatedAt: string | null;
}

function hitsOf(data: unknown, depth = 0): readonly Hit[] | null {
  if (typeof data === 'string') {
    try {
      return hitsOf(JSON.parse(data), depth);
    } catch {
      return null;
    }
  }
  if (typeof data !== 'object' || data === null || depth > 3) return null;
  const record = data as Record<string, unknown>;
  const results = record['results'];
  if (Array.isArray(results)) {
    return results.flatMap((raw): Hit[] => {
      if (typeof raw !== 'object' || raw === null) return [];
      const hit = raw as Record<string, unknown>;
      if (typeof hit['kind'] !== 'string' || typeof hit['id'] !== 'string') return [];
      return [
        {
          kind: hit['kind'],
          id: hit['id'],
          title: typeof hit['title'] === 'string' ? hit['title'] : '',
          audience: typeof hit['audience'] === 'string' ? hit['audience'] : null,
          updatedAt: typeof hit['updatedAt'] === 'string' ? hit['updatedAt'] : null,
        },
      ];
    });
  }
  for (const key of ['data', 'body', 'result']) {
    const inner = hitsOf(record[key], depth + 1);
    if (inner !== null) return inner;
  }
  return null;
}

/**
 * The search result as numbered sources for the model: kind, title, in-app path, audience, last
 * change. `null` when the result is not a list of hits (an error passes through unchanged).
 */
export function knowledgeSources(data: unknown): string | null {
  const hits = hitsOf(data);
  if (hits === null) return null;
  if (hits.length === 0) return 'No sources found that you can open.';
  return hits
    .map((hit, index) => {
      const href = recordHref(hit.kind, hit.id);
      const parts = [
        `[${String(index + 1)}] ${hit.kind}`,
        hit.title === '' ? '(untitled)' : hit.title,
        href === null ? `id ${hit.id}` : href,
        ...(hit.audience === null ? [] : [hit.audience]),
        ...(hit.updatedAt === null ? [] : [`updated ${hit.updatedAt}`]),
      ];
      return parts.join(' | ');
    })
    .join('\n');
}

const DASH = String.fromCodePoint(0x2014);

const RECORD_PATH = String.raw`/(?:work|projects|docs|files|quotes|finance/invoices|calendar/meetings)/([A-Za-z0-9_%-]+)`;
const MARKDOWN_RECORD_LINK = new RegExp(String.raw`\[([^\]\n]*)\]\((${RECORD_PATH})\)`, 'g');
const BARE_RECORD_PATH = new RegExp(String.raw`(?<![\w(/])(${RECORD_PATH})`, 'g');

/**
 * Keeps a link to a record only when that record's id came back from a tool this turn (or the
 * member wrote it): `evidence` is what the tools returned and the member wrote. A Markdown link
 * that fails is reduced to its label; a bare path that fails becomes a dash. Navigation paths
 * (`/home`, `/settings/…`) are not record links and are left to the answer guard.
 */
export function validateRecordLinks(
  text: string,
  evidence: readonly string[],
): { readonly text: string; readonly unverifiedLinks: number } {
  let unverifiedLinks = 0;
  const known = (id: string) => {
    const raw = decodeURIComponent(id);
    return evidence.some((source) => source.includes(raw));
  };
  const linked = text.replace(MARKDOWN_RECORD_LINK, (whole, label: string, _path, id: string) => {
    if (known(id)) return whole;
    unverifiedLinks += 1;
    return label;
  });
  // The lookbehind skips a path inside a Markdown link (already checked above).
  const bare = linked.replace(BARE_RECORD_PATH, (whole, _path: string, id: string) => {
    if (known(id)) return whole;
    unverifiedLinks += 1;
    return DASH;
  });
  return { text: bare, unverifiedLinks };
}

/**
 * 62-24 (plan 62 §4.4 level 3) — `search_file_passages`: the passages of files the member can
 * open that best answer the question (`GET …/knowledge/file-passages`, op
 * `knowledge.file_passages.list`). The route filters by workspace, project and audience before
 * ranking and re-checks every hit; passages are text other people wrote, so they are marked
 * untrusted and taint the turn like every search result.
 */
export const SEARCH_FILE_PASSAGES_TOOL = 'search_file_passages';
export const SEARCH_FILE_PASSAGES_OP = 'knowledge.file_passages.list';
export const FILE_PASSAGE_LIMIT = 6;
/** The passage route's own query cap (`knowledge.controller.ts` MAX_PASSAGE_QUERY_LENGTH). */
export const FILE_PASSAGE_QUERY_MAX_CHARS = 300;

export const FILE_PASSAGES_TOOL: AiToolDefinition = Object.freeze({
  name: SEARCH_FILE_PASSAGES_TOOL,
  description:
    'Find the passages inside uploaded files (PDF, Word, slides, sheets, text) that answer a ' +
    'question, from files the member can open. Returns numbered sources with the file, its ' +
    'in-app path and page; quote them and cite the file as a link.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query', 'projectId'],
    properties: {
      query: { type: 'string', description: 'The question or words to look for.' },
      projectId: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'Only files of this project, or null for the whole workspace.',
      },
    },
  },
}) as AiToolDefinition;

/** The `knowledge.file_passages.list` arguments of a `search_file_passages` call. */
export function filePassageArgs(input: Readonly<Record<string, unknown>>): {
  readonly q: string;
  readonly projectId?: string;
  readonly limit: number;
} {
  const q = [...String(input['query'] ?? '').trim()]
    .slice(0, FILE_PASSAGE_QUERY_MAX_CHARS)
    .join('');
  const projectId = input['projectId'];
  return {
    q,
    ...(typeof projectId === 'string' && projectId !== '' ? { projectId } : {}),
    limit: FILE_PASSAGE_LIMIT,
  };
}

interface PassageHit {
  readonly fileId: string;
  readonly fileName: string;
  readonly pageNo: number | null;
  readonly text: string;
}

function passagesOf(data: unknown, depth = 0): readonly PassageHit[] | null {
  if (typeof data === 'string') {
    try {
      return passagesOf(JSON.parse(data), depth);
    } catch {
      return null;
    }
  }
  if (typeof data !== 'object' || data === null || depth > 3) return null;
  const record = data as Record<string, unknown>;
  const passages = record['passages'];
  if (Array.isArray(passages)) {
    return passages.flatMap((raw): PassageHit[] => {
      if (typeof raw !== 'object' || raw === null) return [];
      const hit = raw as Record<string, unknown>;
      if (typeof hit['fileId'] !== 'string' || typeof hit['text'] !== 'string') return [];
      return [
        {
          fileId: hit['fileId'],
          fileName: typeof hit['fileName'] === 'string' ? hit['fileName'] : '',
          pageNo: typeof hit['pageNo'] === 'number' ? hit['pageNo'] : null,
          text: hit['text'],
        },
      ];
    });
  }
  for (const key of ['data', 'body', 'result']) {
    const inner = passagesOf(record[key], depth + 1);
    if (inner !== null) return inner;
  }
  return null;
}

/**
 * The passages as numbered sources: `[n] file | name | /files/<id> | page p`, then the passage
 * text on the next lines. `null` when the result is not a passage list (errors pass through).
 */
export function filePassageSources(data: unknown): string | null {
  const passages = passagesOf(data);
  if (passages === null) return null;
  if (passages.length === 0) return 'No file passages found that you can open.';
  return passages
    .map((passage, index) => {
      const head = [
        `[${String(index + 1)}] file`,
        passage.fileName === '' ? '(untitled)' : passage.fileName,
        recordHref('file', passage.fileId) ?? `id ${passage.fileId}`,
        ...(passage.pageNo === null ? [] : [`page ${String(passage.pageNo)}`]),
      ].join(' | ');
      return [head, passage.text].join(String.fromCodePoint(10));
    })
    .join(String.fromCodePoint(10, 10));
}
