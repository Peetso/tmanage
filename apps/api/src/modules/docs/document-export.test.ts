import { type Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { isInternalOnlyCapability } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { type ApiError } from '../../common/http/errors.js';
import { DocumentsService } from './documents.service.js';
import type { DocumentsRepository } from './documents.repository.js';
import { DocumentExportController } from './document-export.controller.js';
import { renderDocumentMarkdown } from './document-export.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DocumentRow } from '../../common/database/schema.js';

/**
 * DOC export (x131) proofs, database-free over the module's fakes.
 *
 * Four key behaviours, one test each (features budget 0.05):
 *
 * 1. the pure renderer emits the current-version body under a title front-matter block;
 * 2. the controller returns that Markdown as `text/markdown` for a caller who may read the document;
 * 3. a cross-tenant `documentId` is a **404**, never a 500 — the real `authorize` inside
 *    `DocumentsService.get` drops the row on the tenant check, exactly as the read screen relies on;
 * 4. the route is wired to `doc.read`, an internal-only capability — so the guard's ordinary 403 for
 *    a caller without `doc.read` (and, being internal-only, for every client principal) is generic
 *    and proven in `capability.guard` + the permission-matrix fixture, not re-proven here.
 *
 * The fake `findById` deliberately does **not** apply the tenant scope the real SQL applies, so a
 * cross-tenant row reaches the service and its `authorize()` guard must drop it — belt-and-braces to
 * the scoped query, exactly as `documents.test.ts` does.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const DOCUMENT = 'document-0000-0000-0000-0000-00000000d001';

function owner(): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function documentRow(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: DOCUMENT,
    organizationId: ORG,
    projectId: PROJECT,
    title: 'Kickoff notes',
    body: 'Line one.\nLine two.',
    createdByUserId: USER,
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    updatedAt: new Date('2026-09-02T12:00:00.000Z'),
    ...overrides,
  } as DocumentRow;
}

/** A controller over a real `DocumentsService` whose repository `findById` ignores the tenant scope. */
function controllerWith(seed: readonly DocumentRow[]): DocumentExportController {
  const store: DocumentRow[] = [...seed];
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    findById: async (_runner: unknown, _ctx: unknown, documentId: string) =>
      store.find((row) => row.id === documentId) ?? null,
  } as unknown as DocumentsRepository;
  const service = new DocumentsService(database, repository);
  return new DocumentExportController(service);
}

/** A reply that records the headers the handler sets. */
function headerRecorder(): {
  headers: Record<string, string>;
  reply: { header(n: string, v: string): void };
} {
  const headers: Record<string, string> = {};
  return {
    headers,
    reply: {
      header(name: string, value: string) {
        headers[name] = value;
      },
    },
  };
}

/** Drain a `StreamableFile`'s stream to a UTF-8 string. */
async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

describe('renderDocumentMarkdown', () => {
  it('emits the current-version body under a YAML title front-matter block', () => {
    const markdown = renderDocumentMarkdown({ title: 'Kickoff notes', body: 'Body text.' });
    expect(markdown).toBe('---\ntitle: "Kickoff notes"\n---\n\nBody text.\n');
  });

  it('escapes a title that would break out of the front-matter, and never adds a second key', () => {
    const markdown = renderDocumentMarkdown({ title: 'Sprint: "Q4"\nplan', body: 'x' });
    // The line break folds to a space and the quotes are escaped, so the block stays one key.
    expect(markdown).toBe('---\ntitle: "Sprint: \\"Q4\\" plan"\n---\n\nx\n');
    expect(markdown.match(/^title:/gm)).toHaveLength(1);
  });
});

describe('DocumentExportController', () => {
  it('returns the current-version Markdown as text/markdown for a caller who may read', async () => {
    const controller = controllerWith([documentRow()]);
    const { headers, reply } = headerRecorder();

    const file = await controller.export(context, owner(), DOCUMENT, reply);

    expect(headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(headers['content-disposition']).toContain('attachment; filename=');
    expect(headers['cache-control']).toBe('private, no-store');
    expect(await readStream(file.getStream())).toBe(
      '---\ntitle: "Kickoff notes"\n---\n\nLine one.\nLine two.\n',
    );
  });

  it('answers a cross-tenant documentId with 404, never a 500', async () => {
    // The row exists but belongs to another tenant; the real `authorize` in `get` denies on the
    // tenant check, and the service maps that to the same 404 an unknown id would give.
    const controller = controllerWith([documentRow({ organizationId: OTHER_ORG })]);
    const { reply } = headerRecorder();

    await expect(controller.export(context, owner(), DOCUMENT, reply)).rejects.toMatchObject({
      status: 404,
    } satisfies Partial<ApiError>);
  });

  it('gates the export route on doc.read, an internal-only capability', () => {
    // The 403 for a caller without `doc.read` — and, because `doc.read` is internal-only, for every
    // client principal — is the globally-registered CapabilityGuard's, proven generically in
    // `capability.guard` + the permission-matrix fixture. This asserts the wiring the guard reads.
    const capability = new Reflector().get(
      REQUIRED_CAPABILITY,
      DocumentExportController.prototype.export,
    );
    expect(capability).toBe('doc.read');
    expect(isInternalOnlyCapability('doc.read')).toBe(true);
  });
});
