import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { FileAssetRow } from '../../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../../common/database/tenant-context.js';
import { ApiError } from '../../../common/http/errors.js';
import { FileKnowledgeController } from './file-knowledge.controller.js';
import {
  FILE_SUMMARY_MAX_CHARS,
  FILE_TEXT_READ_MAX_CHARS,
  FileKnowledgeService,
  fileKnowledgeStatus,
} from './file-knowledge.js';
import type {
  FileKnowledgeRepository,
  FileKnowledgeState,
  FileTextState,
  NewFileSummary,
} from './file-knowledge.repository.js';
import type { Passage } from './knowledge-retrieval.js';

/**
 * 62-25 — the file route's read rule (404 for every file the member cannot open, with no hint),
 * what it carries (summary and passages, or the text; never a scan's content), and the summary
 * cache's write. The SQL half (keys, audience, orphan delete) is `t-62-25-file-summaries.db.test.ts`.
 */

const ORG = '0190a3e4-0000-7000-8000-0000000000c1';
const CONTEXT = { organizationId: ORG } as TenantContext;

function member(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'u1',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'm1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: ['p1'],
    hasOrgWideScope: false,
    ...overrides,
  };
}

function asset(overrides: Partial<FileAssetRow> = {}): FileAssetRow {
  return {
    id: 'f1',
    organizationId: ORG,
    projectId: 'p1',
    clientOrganizationId: null,
    ownerUserId: 'u1',
    name: 'Contract.pdf',
    purpose: 'deliverable',
    objectId: null,
    audience: 'internal',
    status: 'ready',
    rejectionCode: null,
    scanClaimedAt: null,
    purgedAt: null,
    version: 1,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    deletedAt: null,
    deletedByUserId: null,
    deletedReason: null,
    purgeAfter: null,
    ...overrides,
  } as FileAssetRow;
}

function text(overrides: Partial<FileTextState> = {}): FileTextState {
  return {
    id: 't1',
    status: 'ready',
    reasonCode: null,
    charCount: 33,
    pageCount: 2,
    truncated: false,
    body: 'The notice period is thirty days.',
    ...overrides,
  };
}

function state(overrides: Partial<FileKnowledgeState> = {}): FileKnowledgeState {
  return { asset: asset(), contentHash: 'h1', text: text(), summary: null, ...overrides };
}

const database = {
  read: (_c: unknown, work: (db: unknown) => unknown) => work({}),
  transaction: (_c: unknown, work: (tx: unknown) => unknown) => work({}),
} as unknown as TenantDatabase;

const PASSAGE: Passage = {
  fileId: 'f1',
  fileName: 'Contract.pdf',
  projectId: 'p1',
  pageNo: 2,
  chunkNo: 0,
  text: 'Notice: thirty days.',
  score: 0.5,
};

function setup(read: FileKnowledgeState | null, upserted = true) {
  const asked: { query: string; options: unknown }[] = [];
  const written: NewFileSummary[] = [];
  const repository = {
    read: () => Promise.resolve(read),
    upsertSummary: (_r: unknown, _c: unknown, summary: NewFileSummary) => {
      written.push(summary);
      return Promise.resolve(upserted);
    },
  } as unknown as FileKnowledgeRepository;
  const retrieval = {
    passages: (_c: TenantContext, _p: Principal, query: string, options: unknown) => {
      asked.push({ query, options });
      return Promise.resolve([PASSAGE]);
    },
  };
  const service = new FileKnowledgeService(database, repository, retrieval);
  return { service, asked, written };
}

async function status(work: Promise<unknown>): Promise<number | string> {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return error instanceof ApiError ? `${String(error.status)} ${error.auditCode ?? ''}` : 'other';
  }
}

describe('the file route (62-25)', () => {
  it('names the state of a file’s text, a scan apart', () => {
    expect(fileKnowledgeStatus(state())).toBe('ready');
    expect(fileKnowledgeStatus(state({ contentHash: null, text: null }))).toBe('pending');
    expect(fileKnowledgeStatus(state({ text: text({ status: 'pending' }) }))).toBe('pending');
    expect(
      fileKnowledgeStatus(
        state({ text: text({ status: 'unsupported', reasonCode: 'pdf_no_text_layer' }) }),
      ),
    ).toBe('scan_only');
    expect(
      fileKnowledgeStatus(state({ text: text({ status: 'failed', reasonCode: 'pdf_failed' }) })),
    ).toBe('unsupported');
  });

  it('without a summary: the text (cut at the cap), and no passages', async () => {
    const long = 'x'.repeat(FILE_TEXT_READ_MAX_CHARS + 10);
    const { service, asked } = setup(state({ text: text({ body: long, charCount: long.length }) }));
    const view = await service.view(CONTEXT, member(), 'f1', 'notice');
    expect(view).toMatchObject({
      fileId: 'f1',
      href: '/files/f1',
      status: 'ready',
      textId: 't1',
      summary: null,
      textCut: true,
      passages: [],
    });
    expect(view.text).toHaveLength(FILE_TEXT_READ_MAX_CHARS);
    expect(asked).toEqual([]);
  });

  it('with a summary: the summary and this file’s passages for the question, not the text', async () => {
    const { service, asked } = setup(
      state({ summary: { summary: 'A contract.', model: 'claude-haiku-5-5' } }),
    );
    const view = await service.view(CONTEXT, member(), 'f1', 'notice');
    expect(view).toMatchObject({ summary: 'A contract.', text: null });
    expect(view.passages).toEqual([
      expect.objectContaining({ fileId: 'f1', pageNo: 2, text: 'Notice: thirty days.' }),
    ]);
    expect(asked).toEqual([
      { query: 'notice', options: { projectId: 'p1', fileAssetId: 'f1', limit: 4 } },
    ]);
  });

  it('a scan carries no text and says why', async () => {
    const { service } = setup(
      state({
        text: text({ status: 'unsupported', reasonCode: 'pdf_no_text_layer', body: null }),
      }),
    );
    const view = await service.view(CONTEXT, member(), 'f1', null);
    expect(view).toMatchObject({
      status: 'scan_only',
      reasonCode: 'pdf_no_text_layer',
      text: null,
    });
  });

  it('is 404 for every file the member cannot open, with the same answer', async () => {
    const cases: [string, FileKnowledgeState | null, Principal][] = [
      ['no such file', null, member()],
      ['deleted', state({ asset: asset({ deletedAt: new Date() }) }), member()],
      ['purged', state({ asset: asset({ purgedAt: new Date() }) }), member()],
      ['rejected', state({ asset: asset({ status: 'rejected' }) }), member()],
      ['another workspace', state({ asset: asset({ organizationId: 'org-2' }) }), member()],
      ['not on the project', state(), member({ projectIds: ['p2'] })],
      [
        'a client',
        state(),
        member({ kind: 'client', role: 'client_member', clientOrganizationId: 'c1' }),
      ],
    ];
    for (const [why, read, who] of cases) {
      const { service } = setup(read);
      expect(await status(service.view(CONTEXT, who, 'f1', null)), why).toBe(
        '404 knowledge.file_not_visible',
      );
    }
  });

  it('caps q at the passage route’s length', async () => {
    const { service } = setup(state());
    const route = new FileKnowledgeController(service);
    expect(await status(route.file(CONTEXT, member(), 'f1', 'q'.repeat(301)))).toBe('400 ');
    expect((await route.file(CONTEXT, member(), 'f1', '   ')).fileId).toBe('f1');
  });
});

describe('the summary cache (62-25)', () => {
  it('keeps a trimmed summary under the cap, keyed by the text row and audience it is given', async () => {
    const { service, written } = setup(state());
    const long = ` ${'s'.repeat(FILE_SUMMARY_MAX_CHARS + 5)} `;
    expect(
      await service.recordSummary(
        CONTEXT,
        { textId: 't1', audience: 'client_visible', summary: long, model: 'claude-haiku-5-5' },
        new Date(0),
      ),
    ).toBe(true);
    expect(written).toEqual([
      {
        textId: 't1',
        audience: 'client_visible',
        summary: 's'.repeat(FILE_SUMMARY_MAX_CHARS),
        model: 'claude-haiku-5-5',
      },
    ]);
  });

  it('writes nothing for an empty summary', async () => {
    const { service, written } = setup(state());
    expect(
      await service.recordSummary(
        CONTEXT,
        { textId: 't1', audience: 'internal', summary: '  ', model: 'm' },
        new Date(0),
      ),
    ).toBe(false);
    expect(written).toEqual([]);
  });
});
