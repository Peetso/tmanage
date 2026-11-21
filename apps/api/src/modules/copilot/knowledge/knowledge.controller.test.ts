import type { Principal } from '@tmanage/domain';
import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../../common/database/tenant-context.js';
import { ApiError } from '../../../common/http/errors.js';
import { KnowledgeController } from './knowledge.controller.js';
import type { KnowledgeRetrieval, Passage } from './knowledge-retrieval.js';

/** 62-24 — the passage route: input checks, the project gate, and the view (no storage key). */

const CONTEXT = { organizationId: '00000000-0000-4000-8000-000000000001' } as TenantContext;

function member(projectIds: readonly string[], hasOrgWideScope = false): Principal {
  return { projectIds, hasOrgWideScope } as unknown as Principal;
}

const PASSAGE: Passage = {
  fileId: 'file 1',
  fileName: 'Contract.pdf',
  projectId: 'prj_1',
  pageNo: 3,
  chunkNo: 0,
  text: 'The notice period is thirty days.',
  score: 0.5,
};

function controller() {
  const calls: { query: string; options: unknown }[] = [];
  const retrieval = {
    passages: (_c: TenantContext, _p: Principal, query: string, options: unknown) => {
      calls.push({ query, options });
      return Promise.resolve([PASSAGE]);
    },
  } as unknown as KnowledgeRetrieval;
  return { route: new KnowledgeController(retrieval), calls };
}

async function status(promise: Promise<unknown>): Promise<number | string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return error instanceof ApiError ? error.status : 'other';
  }
}

describe('GET knowledge/file-passages (62-24)', () => {
  it('answers passages with the in-app path and no storage key', async () => {
    const { route, calls } = controller();
    const view = await route.filePassages(CONTEXT, member(['prj_1']), '  notice  ', 'prj_1', '4');
    expect(calls).toEqual([{ query: 'notice', options: { projectId: 'prj_1', limit: 4 } }]);
    expect(view).toEqual({
      passages: [
        {
          fileId: 'file 1',
          fileName: 'Contract.pdf',
          projectId: 'prj_1',
          pageNo: 3,
          href: '/files/file%201',
          text: 'The notice period is thirty days.',
        },
      ],
    });
    expect(Object.keys(view.passages[0]!)).not.toContain('score');
  });

  it('refuses an empty or over-long query and a limit outside 1..10', async () => {
    const { route, calls } = controller();
    const who = member(['prj_1']);
    expect(await status(route.filePassages(CONTEXT, who, '   '))).toBe(400);
    expect(await status(route.filePassages(CONTEXT, who, 'x'.repeat(301)))).toBe(400);
    expect(await status(route.filePassages(CONTEXT, who, 'x'.repeat(300)))).toBe('ok');
    for (const limit of ['0', '11', '2.5', 'abc']) {
      expect(await status(route.filePassages(CONTEXT, who, 'q', undefined, limit))).toBe(400);
    }
    expect(await status(route.filePassages(CONTEXT, who, 'q', ''))).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('a project the member is not on is 404 before any search; org-wide scope may name any', async () => {
    const { route, calls } = controller();
    expect(await status(route.filePassages(CONTEXT, member(['prj_1']), 'q', 'prj_2'))).toBe(404);
    expect(calls).toHaveLength(0);
    expect(await status(route.filePassages(CONTEXT, member([], true), 'q', 'prj_2'))).toBe('ok');
  });
});
