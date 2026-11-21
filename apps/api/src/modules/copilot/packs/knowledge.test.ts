import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { mayReadHit } from '../../search/search-permission.js';
import type { SearchIndexHitRow } from '../../search/search-index.repository.js';
import { SEARCH_RESULT_KINDS } from '../../search/search.service.js';
import { planToolCall } from '../ai-chat-tools.js';
import { PACK_OPS } from './index.js';
import {
  KNOWLEDGE_QUERY_MAX_CHARS,
  KNOWLEDGE_TOOL,
  knowledgeSources,
  recordHref,
  validateRecordLinks,
} from './knowledge.js';

/**
 * 62-22 (plan 62 §4.4, §9 row) — the knowledge pack: structured finders, `search_knowledge` over
 * the existing search with its per-hit rule, and citations as validated in-app links.
 */

const OTHER = '0190a3e4-0000-7000-8000-00000000beef';

describe('knowledge pack (62-22)', () => {
  it('the structured finders reach clients, projects, files, documents, invoices and quotes', () => {
    const files = PACK_OPS.files ?? [];
    for (const id of [
      'client_organizations.list',
      'projects.list',
      'projects.files.list',
      'documents.list',
      'billing.invoices.list',
      'quotes.list',
    ]) {
      expect(files).toContain(id);
    }
  });

  it('search_knowledge is one strict tool that runs the member’s own global search', () => {
    expect(KNOWLEDGE_TOOL.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ['query', 'projectId'],
    });
    expect(planToolCall('search_knowledge', { query: ' brief ', projectId: null })).toEqual({
      kind: 'run',
      catalogTool: 'tmanage_run_action',
      args: { action_id: 'search.list', args: { q: 'brief', limit: 10 } },
      opId: 'search.list',
    });
    const long = planToolCall('search_knowledge', { query: 'x'.repeat(500), projectId: 'p1' });
    expect(long).toMatchObject({ args: { args: { projectId: 'p1' } } });
    expect((long as unknown as { args: { args: { q: string } } }).args.args.q.length).toBe(
      KNOWLEDGE_QUERY_MAX_CHARS,
    );
    expect(planToolCall('search_knowledge', { query: '  ', projectId: null })).toMatchObject({
      kind: 'refuse',
    });
  });

  it('the per-hit rule refuses, for every kind, a hit from another workspace or out of reach', () => {
    const outsider: Principal = {
      userId: 'u',
      organizationId: 'org-1',
      kind: 'internal',
      role: 'guest',
      membershipId: 'm',
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds: [],
      hasOrgWideScope: false,
    };
    const base: SearchIndexHitRow = {
      organizationId: 'org-1',
      projectId: 'project-elsewhere',
      targetKind: 'work_item',
      targetId: 'x',
      title: 't',
      audience: 'internal',
      updatedAt: new Date('2026-11-21T00:00:00Z'),
    };
    for (const kind of SEARCH_RESULT_KINDS) {
      const hit = { ...base, targetKind: kind } as SearchIndexHitRow;
      expect(mayReadHit(outsider, { ...hit, organizationId: 'org-2' }), kind).toBe(false);
      expect(mayReadHit(outsider, hit), kind).toBe(false);
    }
  });

  it('hits become numbered sources with the same in-app paths as the web', () => {
    const web = readFileSync(
      new URL('../../../../../web/src/components/shell/command-palette-model.ts', import.meta.url),
      'utf8',
    );
    const webHref = web.slice(web.indexOf('export function resultHref'));
    for (const kind of SEARCH_RESULT_KINDS) {
      const href = recordHref(kind, 'ID');
      if (href === null) {
        expect(webHref.slice(0, webHref.indexOf('default:'))).not.toContain(`'${kind}'`);
      } else {
        expect(webHref, kind).toContain(
          `case '${kind}':\n      return \`${href.replace('ID', '$' + '{id}')}\``,
        );
      }
    }
    const text = knowledgeSources({
      results: [
        {
          kind: 'document',
          id: 'doc_1',
          title: 'Brand brief',
          audience: 'internal',
          updatedAt: 'x',
        },
        { kind: 'message', id: 'msg_1', title: 'Hello', audience: 'internal', updatedAt: 'y' },
      ],
    });
    expect(text).toBe(
      '[1] document | Brand brief | /docs/doc_1 | internal | updated x\n' +
        '[2] message | Hello | id msg_1 | internal | updated y',
    );
    expect(knowledgeSources({ results: [] })).toBe('No sources found that you can open.');
    expect(knowledgeSources('not json')).toBeNull();
  });

  it('a record link survives only when a tool returned that record this turn', () => {
    const evidence = ['[1] document | Brief | /docs/doc_1'];
    const answer =
      `See [the brief](/docs/doc_1) and [the plan](/docs/${OTHER}); also /work/wi_9 ` +
      'and the [calendar](/calendar).';
    const checked = validateRecordLinks(answer, evidence);
    expect(checked.text).toBe(
      'See [the brief](/docs/doc_1) and the plan; also — and the [calendar](/calendar).',
    );
    expect(checked.unverifiedLinks).toBe(2);
  });
});
