import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { assertTenantScoped } from '../../common/database/tenant-guard.js';
import {
  FilePreviewsRepository,
  InvalidPreviewKindError,
  PREVIEW_MAX_ATTEMPTS,
  parseMeta,
  type PreviewKind,
} from './file-previews.repository.js';

/**
 * R4 slice 2 — `FilePreviewsRepository` without a server.
 *
 * The fake runner records every statement the real Drizzle proxy builds and runs it through the
 * tenant guard in `enforce` mode, so each case also proves its SQL carries the active tenant's
 * predicate (bound, not literal). Selects answer positional rows in the table's column order, the
 * shape `tenantDrizzle` asks mysql2 for (`rowsAsArray`).
 */

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** `file_previews`' columns in `schema.ts` order — the order positional rows arrive in. */
const COLUMNS = [
  'id',
  'organization_id',
  'file_asset_id',
  'file_version_id',
  'kind',
  'page_no',
  'status',
  'object_key',
  'mime_type',
  'size_bytes',
  'width',
  'height',
  'meta',
  'error_code',
  'attempts',
  'claimed_at',
  'created_at',
  'updated_at',
] as const;

function contextFor(organizationId: string): TenantContext {
  return createTenantContext({
    organizationId,
    userId: uuidv7(),
    principalKind: 'internal',
    membershipId: uuidv7(),
    capabilities: [],
    policyVersion: 'test',
    correlationId: uuidv7(),
  });
}

const ORG = uuidv7();
const context = contextFor(ORG);
const ASSET = uuidv7();
const VERSION = uuidv7();
const NOW = new Date('2026-11-01T10:00:00.000Z');
const STALE = new Date('2026-11-01T09:45:00.000Z');

function fakeRunner(
  answer: (statement: Statement) => unknown = () => ({ affectedRows: 1 }),
  guarded = true,
  guardAs: TenantContext = context,
): { runner: TenantQueryRunner; statements: Statement[] } {
  const statements: Statement[] = [];
  const respond = (async (sql: string, params: readonly unknown[] = []) => {
    const statement = { sql, params };
    statements.push(statement);
    if (guarded) {
      assertTenantScoped(sql, params, guardAs, { mode: 'enforce' });
    }
    return answer(statement);
  }) as unknown as TenantQueryRunner['query'];
  const execute = respond as unknown as TenantQueryRunner['execute'];
  return {
    runner: { query: respond, execute, unscoped: () => ({ query: respond, execute }) },
    statements,
  };
}

/** One positional row, as mysql2 answers with `rowsAsArray`. */
function positional(values: Record<string, unknown>): unknown[] {
  return COLUMNS.map((name) => (name in values ? values[name] : null));
}

function storedRow(overrides: Record<string, unknown> = {}): unknown[] {
  return positional({
    id: uuidv7(),
    organization_id: ORG,
    file_asset_id: ASSET,
    file_version_id: VERSION,
    kind: 'thumb',
    page_no: 0,
    status: 'pending',
    attempts: 0,
    created_at: '2026-11-01 09:00:00.000',
    updated_at: '2026-11-01 09:00:00.000',
    ...overrides,
  });
}

const repository = new FilePreviewsRepository();

describe('FilePreviewsRepository — pending rows', () => {
  it('inserts one pending row per derivative, page 0 by default, and keeps existing rows', async () => {
    const { runner, statements } = fakeRunner();
    await repository.ensurePending(
      runner,
      context,
      {
        fileAssetId: ASSET,
        fileVersionId: VERSION,
        previews: [{ kind: 'thumb' }, { kind: 'page_thumb', pageNo: 2 }],
      },
      NOW,
    );
    expect(statements).toHaveLength(1);
    const [insert] = statements as [Statement];
    expect(insert.sql).toMatch(/^insert into `file_previews`/);
    // A re-run is a no-op on the unique key, never a reset of a ready row.
    expect(insert.sql).toMatch(/on duplicate key update `kind` = kind/);
    expect(insert.sql).not.toMatch(/`status` =/);
    expect(insert.params.filter((p) => p === ORG)).toHaveLength(2);
    expect(insert.params).toContain('page_thumb');
    expect(insert.params).toContain(2);
    expect(insert.params.filter((p) => p === 'pending')).toHaveLength(2);
  });

  it('writes nothing for an empty list', async () => {
    const { runner, statements } = fakeRunner();
    await repository.ensurePending(
      runner,
      context,
      { fileAssetId: ASSET, fileVersionId: VERSION, previews: [] },
      NOW,
    );
    expect(statements).toHaveLength(0);
  });

  it('refuses a kind outside the closed list and a negative page, before any write', async () => {
    const { runner, statements } = fakeRunner();
    await expect(
      repository.ensurePending(
        runner,
        context,
        {
          fileAssetId: ASSET,
          fileVersionId: VERSION,
          previews: [{ kind: 'figma_snapshot' as PreviewKind }],
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(InvalidPreviewKindError);
    await expect(
      repository.ensurePending(
        runner,
        context,
        { fileAssetId: ASSET, fileVersionId: VERSION, previews: [{ kind: 'thumb', pageNo: -1 }] },
        NOW,
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(statements).toHaveLength(0);
  });
});

describe('FilePreviewsRepository — the queue', () => {
  it('lists pending rows nobody holds, oldest first, capped at 500', async () => {
    const row = storedRow();
    const { runner, statements } = fakeRunner(() => [row]);
    const pending = await repository.listPending(runner, context, STALE, 10_000);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe('pending');
    const [select] = statements as [Statement];
    expect(select.sql).toMatch(/`status` = \?/);
    expect(select.sql).toMatch(/`claimed_at` is null or `file_previews`.`claimed_at` < \?/);
    expect(select.sql).toMatch(/order by `file_previews`.`created_at` asc/);
    expect(select.params).toContain(500);
  });

  it('claims only a pending, unheld row at the attempt count read', async () => {
    const { runner, statements } = fakeRunner(() => ({ affectedRows: 1 }));
    expect(await repository.claim(runner, context, { id: 'p1', attempts: 1 }, NOW, STALE)).toBe(
      true,
    );
    const [update] = statements as [Statement];
    expect(update.sql).toMatch(/^update `file_previews` set `claimed_at` = \?/);
    expect(update.sql).toMatch(/`status` = \?/);
    expect(update.sql).toMatch(/`attempts` = \?/);
    expect(update.sql).toMatch(/`claimed_at` is null/);
    expect(update.params).toContain('pending');
    expect(update.params).toContain(1);
  });

  it('answers false when another pass took the row first', async () => {
    const { runner } = fakeRunner(() => ({ affectedRows: 0 }));
    expect(await repository.claim(runner, context, { id: 'p1', attempts: 0 }, NOW, STALE)).toBe(
      false,
    );
  });

  it('reads the organizations with work through the bootstrap runner, without a tenant predicate', async () => {
    const { runner, statements } = fakeRunner(() => [[ORG]], false);
    const organizations = await repository.organizationsWithPending(
      runner as unknown as BootstrapQueryRunner,
      STALE,
    );
    expect(organizations).toEqual([ORG]);
    const [select] = statements as [Statement];
    expect(select.sql).toMatch(/^select distinct `organization_id` from `file_previews`/);
    expect(select.sql).not.toMatch(/`organization_id` = \?/);
    expect(select.params).toContain('pending');
  });
});

describe('FilePreviewsRepository — outcomes', () => {
  it('marks a derivative ready with its key, size, dimensions and meta, only while pending', async () => {
    const { runner, statements } = fakeRunner(() => ({ affectedRows: 1 }));
    const wrote = await repository.markReady(
      runner,
      context,
      'p1',
      {
        objectKey: `tenant/${ORG}/derivative/${VERSION}/p1`,
        mimeType: 'image/webp',
        sizeBytes: 2048,
        width: 320,
        height: 200,
        meta: { approximate: false },
      },
      NOW,
    );
    expect(wrote).toBe(true);
    const [update] = statements as [Statement];
    expect(update.params).toContain('ready');
    expect(update.params).toContain('image/webp');
    expect(update.params).toContain(JSON.stringify({ approximate: false }));
    // Conditional on still pending: a pass that lost its claim cannot overwrite.
    expect(update.sql).toMatch(
      /where \(`file_previews`.`organization_id` = \? and .*`status` = \?\)/,
    );
    expect(update.params.at(-1)).toBe('pending');
  });

  it('refuses a size that is not a non-negative integer', async () => {
    const { runner, statements } = fakeRunner();
    await expect(
      repository.markReady(
        runner,
        context,
        'p1',
        {
          objectKey: 'k',
          mimeType: 'image/png',
          sizeBytes: -1,
          width: null,
          height: null,
          meta: null,
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(statements).toHaveLength(0);
  });

  it('keeps the row pending and its claim standing below the attempt ceiling', async () => {
    const { runner, statements } = fakeRunner(() => ({ affectedRows: 1 }));
    expect(
      await repository.recordFailure(
        runner,
        context,
        { id: 'p1', attempts: 0 },
        'decode_error',
        NOW,
      ),
    ).toBe('retry');
    const [update] = statements as [Statement];
    const setClause = update.sql.split(' where ')[0] ?? '';
    expect(setClause).not.toMatch(/`claimed_at` = /);
    expect(setClause).not.toMatch(/`status` = /);
    expect(update.params.slice(0, 2)).toEqual(['decode_error', 1]);
  });

  it('turns the row failed, and frees the claim, at the last attempt', async () => {
    const { runner, statements } = fakeRunner(() => ({ affectedRows: 1 }));
    expect(
      await repository.recordFailure(
        runner,
        context,
        { id: 'p1', attempts: PREVIEW_MAX_ATTEMPTS - 1 },
        'x'.repeat(100),
        NOW,
      ),
    ).toBe('failed');
    const [update] = statements as [Statement];
    expect(update.params).toContain('failed');
    expect(update.params).toContain(PREVIEW_MAX_ATTEMPTS);
    expect(update.params).toContain('x'.repeat(64));
    expect(update.sql).toMatch(/`claimed_at` = \?/);
  });

  it('reports a failure on a row that is no longer pending as such', async () => {
    const { runner } = fakeRunner(() => ({ affectedRows: 0 }));
    expect(
      await repository.recordFailure(runner, context, { id: 'p1', attempts: 0 }, 'e', NOW),
    ).toBe('not_pending');
  });

  it('marks unsupported at once, and resets only failed rows of the asset on retry', async () => {
    const { runner, statements } = fakeRunner(() => ({ affectedRows: 2 }));
    expect(await repository.markUnsupported(runner, context, 'p1', 'too_large', NOW)).toBe(false);
    expect(await repository.resetFailed(runner, context, ASSET, NOW)).toBe(2);
    const [unsupported, reset] = statements as [Statement, Statement];
    expect(unsupported.params).toContain('unsupported');
    expect(unsupported.params).toContain('too_large');
    expect(reset.params).toContain(ASSET);
    expect(reset.params.at(-1)).toBe('failed');
    expect(reset.params).toContain('pending');
  });

  it('deletes by id inside the tenant, and does nothing for no ids', async () => {
    const { runner, statements } = fakeRunner(() => ({ affectedRows: 2 }));
    expect(await repository.deleteByIds(runner, context, [])).toBe(0);
    expect(statements).toHaveLength(0);
    expect(await repository.deleteByIds(runner, context, ['a', 'b'])).toBe(2);
    expect(statements[0]?.sql).toMatch(/^delete from `file_previews` where/);
  });
});

describe('FilePreviewsRepository — reads', () => {
  it('parses meta that MariaDB answers as text, and narrows kind and status', async () => {
    const meta = { pages: 2, sizes: [{ w: 595, h: 842 }] };
    const { runner } = fakeRunner(() => [
      storedRow({ kind: 'pdf_meta', status: 'ready', meta: JSON.stringify(meta) }),
      storedRow({ kind: 'thumb', meta: null }),
    ]);
    const previews = await repository.listForAsset(runner, context, ASSET);
    expect(previews.map((p) => p.kind)).toEqual(['pdf_meta', 'thumb']);
    expect(previews[0]?.meta).toEqual(meta);
    expect(previews[1]?.meta).toBeNull();
  });

  it('finds one row by id inside the tenant, and answers null for none', async () => {
    const { runner, statements } = fakeRunner(() => []);
    expect(await repository.findById(runner, context, 'missing')).toBeNull();
    expect(statements[0]?.params).toContain(ORG);
    const listed = fakeRunner(() => [storedRow({ page_no: 3, kind: 'page_thumb' })]);
    const rows = await repository.listForVersion(listed.runner, context, VERSION);
    expect(rows[0]?.pageNo).toBe(3);
  });

  it('binds the active tenant: the guard refuses the same read under another organization', async () => {
    const other = contextFor(uuidv7());
    const { runner } = fakeRunner(() => [], true, other);
    await expect(repository.findById(runner, context, 'p1')).rejects.toThrow();
    await expect(repository.listPending(runner, context, STALE, 10)).rejects.toThrow();
  });
});

describe('parseMeta', () => {
  it('reads an object, text JSON, and nothing else', () => {
    expect(parseMeta({ a: 1 })).toEqual({ a: 1 });
    expect(parseMeta('{"a":1}')).toEqual({ a: 1 });
    expect(parseMeta(null)).toBeNull();
    expect(parseMeta('not json')).toBeNull();
    expect(parseMeta('[1,2]')).toBeNull();
    expect(parseMeta(7)).toBeNull();
  });
});
