import { describe, expect, it } from 'vitest';
import type { Readable } from 'node:stream';
import type { Principal, Role } from '@tmanage/domain';
import { AuditExportController } from './audit-export.controller.js';
import { AuditService } from './audit.service.js';
import type { AuditEventsRepository, ListAuditEventsOptions } from './audit-events.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditEventRow } from '../../common/database/schema.js';

/**
 * ADM-09 filtered export (x197). `AuditExportController.export` — the date-windowed CSV download over
 * `GET .../audit/export.csv`, behind `audit.export`.
 *
 * Database-free proofs with the **real** {@link AuditService}: the capability gate, the tenant scope
 * and the own-activity narrowing are the service's real code, so the controller's own three
 * responsibilities are what these cover — the window validation (400), the in-memory window/action
 * filter, the CSV formula-injection guard — plus the inherited refusal (403) reaching the caller.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const ACTOR = 'user-0000-0000-0000-0000-0000000000aa';

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

function principal(role: Role, overrides: Partial<Principal> = {}): Principal {
  return {
    userId: ACTOR,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
    ...overrides,
  } as Principal;
}

function row(overrides: Partial<AuditEventRow>): AuditEventRow {
  return {
    id: 'audit-0000-0000-0000-0000-000000000000',
    organizationId: ORG,
    actorUserId: ACTOR,
    effectiveActorId: null,
    action: 'project.created',
    objectType: 'project',
    objectId: 'project-0000-0000-0000-0000-000000000001',
    result: 'allowed',
    correlationId: 'correlation-0000-0000-0000-000000000009',
    metadataJson: { secret_token: 'must-never-surface' },
    createdAt: new Date('2026-02-01T09:00:00.000Z'),
    ...overrides,
  } as unknown as AuditEventRow;
}

/** Every audit row the exports append (F53), across the suite. */
const APPENDED: unknown[] = [];

/** A service whose repository holds exactly `rows`, filtered the way the DB-proven `list` is. */
function serviceWith(rows: readonly AuditEventRow[]): AuditService {
  const database = {
    read: async (ctx: unknown, work: (runner: unknown) => Promise<unknown>) => work({ ctx }),
    // Wave 9 S8 (F53): the export's own audit row is written in a transaction of its own.
    transaction: async (ctx: unknown, work: (runner: unknown) => Promise<unknown>) => work({ ctx }),
  } as unknown as TenantDatabase;
  const events = {
    append: async (_runner: unknown, _ctx: unknown, input: unknown) => {
      APPENDED.push(input);
      return input;
    },
    list: async (
      _runner: unknown,
      ctx: TenantContext,
      options: ListAuditEventsOptions = {},
    ): Promise<readonly AuditEventRow[]> => {
      let out = rows.filter((r) => r.organizationId === ctx.organizationId);
      if (options.actorUserId) out = out.filter((r) => r.actorUserId === options.actorUserId);
      out = [...out].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      if (options.before) out = out.filter((r) => r.id < options.before!);
      return out.slice(0, options.limit ?? 50);
    },
  } as unknown as AuditEventsRepository;
  return new AuditService(database, events);
}

/** A reply that captures the headers the download sets. */
function reply(): { header(name: string, value: string): unknown; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  return { headers, header: (name, value) => headers.set(name.toLowerCase(), value) };
}

/** Drain a `StreamableFile`'s stream to a UTF-8 string. */
async function drain(file: { getStream(): Readable }): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf-8');
}

const WIDE = { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' };

describe('AuditExportController.export', () => {
  it('exports only tenant rows inside the window, dropping a cross-tenant and an out-of-window row', async () => {
    const controller = new AuditExportController(
      serviceWith([
        row({ id: 'a1', createdAt: new Date('2026-03-10T00:00:00.000Z') }),
        row({ id: 'a2', createdAt: new Date('2026-09-01T00:00:00.000Z') }), // outside the window
        row({
          id: 'a3',
          organizationId: OTHER_ORG,
          createdAt: new Date('2026-03-11T00:00:00.000Z'),
        }),
      ]),
    );
    const res = reply();
    const csv = await drain(
      await controller.export(
        context,
        principal('owner', { hasOrgWideScope: true }),
        res,
        '2026-03-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z',
        undefined,
        undefined,
      ),
    );
    expect(csv).toContain('a1');
    expect(csv).not.toContain('a2'); // out of window
    expect(csv).not.toContain('a3'); // other tenant
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('neutralises a CSV cell that begins with a formula trigger', async () => {
    const controller = new AuditExportController(
      serviceWith([
        row({ id: 'a1', action: '=cmd,1', createdAt: new Date('2026-03-10T00:00:00.000Z') }),
      ]),
    );
    const csv = await drain(
      await controller.export(
        context,
        principal('owner', { hasOrgWideScope: true }),
        reply(),
        '2026-03-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z',
        undefined,
        undefined,
      ),
    );
    // The guard prefixes a single quote, and the comma then forces RFC-4180 quoting: `"'=cmd,1"`.
    expect(csv).toContain(`"'=cmd,1"`);
    expect(csv).not.toContain(',=cmd,'); // never an unescaped leading '='
  });

  it('refuses an over-wide window with a 400 and never reads', async () => {
    const controller = new AuditExportController(serviceWith([]));
    await expect(
      controller.export(
        context,
        principal('owner', { hasOrgWideScope: true }),
        reply(),
        '2025-01-01T00:00:00.000Z' as unknown as string,
        '2026-12-31T00:00:00.000Z',
        undefined,
        undefined,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a caller with audit.read but not audit.export with a 403 (the two caps are distinct)', async () => {
    const controller = new AuditExportController(serviceWith([]));
    await expect(
      controller.export(
        context,
        principal('member'),
        reply(),
        WIDE.from as unknown as string,
        WIDE.to,
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(ApiError);
    await controller
      .export(
        context,
        principal('member'),
        reply(),
        WIDE.from as unknown as string,
        WIDE.to,
        undefined,
        undefined,
      )
      .catch((error: unknown) => expect((error as ApiError).status).toBe(403));
  });
});
