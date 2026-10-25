import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { ObjectStore } from '@tmanage/storage';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PrivacyDeletionRequestRow, PrivacyExportRow } from '../../common/database/schema.js';
import { ScannerUnavailableError } from '../../common/scan/malware-scanner.js';
import type { MalwareScanner } from '../../common/scan/malware-scanner.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { archiveFileName, packArchive } from './privacy-archive.repository.js';
import type { ArchiveDocument, ArchiveHeader } from './privacy-archive.repository.js';
import { PrivacyPass, privacyJobEnabled } from './privacy-job.js';
import type { PrivacyRepository } from './privacy.repository.js';

/**
 * D5 (Figma F5) — the background half over fakes: an archive goes through the scanner before it can
 * be served, gets a seven-day link, and a due deletion waits while its person is the only owner. No
 * live data is touched: every store, database and repository here is a fake.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000c1';
const EXPORT_ID = '00000000-0000-4000-8000-0000000000d1';
const NOW = new Date('2026-10-25T13:05:00.000Z');
const context = { organizationId: ORG, correlationId: 'c' } as unknown as TenantContext;

type Verdict = 'clean' | 'infected' | 'down' | 'none';

function build(options: { verdict?: Verdict; owners?: number; subjectRole?: string } = {}) {
  const calls: string[] = [];
  const ready: Record<string, unknown>[] = [];
  const database = {
    read: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
    transaction: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
  } as unknown as TenantDatabase;
  const repository = {
    claimExport: () => Promise.resolve(true),
    organization: () => Promise.resolve({ id: ORG, name: 'Northstar Studio' }),
    setProgress: () => Promise.resolve(true),
    markExportReady: (_r: unknown, _c: unknown, _id: string, input: Record<string, unknown>) => {
      ready.push(input);
      return Promise.resolve(true);
    },
    markExportFailed: (_r: unknown, _c: unknown, _id: string, code: string) => {
      calls.push(`failed:${code}`);
      return Promise.resolve(true);
    },
    lockOrganization: () => Promise.resolve(true),
    activeOwnerCount: () => Promise.resolve(options.owners ?? 2),
    activeMembers: () => Promise.resolve([{ userId: OWNER, role: options.subjectRole ?? 'owner' }]),
    offboardMember: () => {
      calls.push('offboard');
      return Promise.resolve(true);
    },
    closeOrganization: () => {
      calls.push('close');
      return Promise.resolve(true);
    },
    markDeletionExecuted: () => {
      calls.push('executed');
      return Promise.resolve(true);
    },
    listPurgeableExports: () => Promise.resolve([]),
  } as unknown as PrivacyRepository;
  const store = {
    promote: () =>
      Promise.resolve({
        sink: { write: () => true },
        commit: () => {
          calls.push('commit');
          return Promise.resolve();
        },
        abort: () => {
          calls.push('abort');
          return Promise.resolve();
        },
      }),
    remove: () => Promise.resolve(),
  } as unknown as ObjectStore;
  const verdict = options.verdict ?? 'clean';
  const scanner =
    verdict === 'none'
      ? ({ kind: 'none', probe: () => Promise.resolve(), scan: () => Promise.reject() } as never)
      : ({
          kind: 'engine',
          probe: () =>
            verdict === 'down'
              ? Promise.reject(new ScannerUnavailableError('engine down'))
              : Promise.resolve(),
          scan: () => Promise.resolve({ verdict: verdict === 'infected' ? 'infected' : 'clean' }),
        } as unknown as Pick<MalwareScanner, 'kind' | 'probe' | 'scan'>);
  const audit = {
    record: (_r: unknown, _c: unknown, input: { action: string }) => {
      calls.push(input.action);
      return Promise.resolve({});
    },
  } as unknown as AuditService;
  const outbox = {
    append: (_r: unknown, _c: unknown, input: { type: string }) => {
      calls.push(input.type);
      return Promise.resolve('e');
    },
  } as unknown as OutboxEventsRepository;
  const builder = {
    build: (_c: unknown, header: ArchiveHeader) =>
      Promise.resolve<ArchiveDocument>({ ...header, sections: {}, truncatedSections: [] }),
  };
  const pass = new PrivacyPass(
    database,
    store,
    scanner,
    audit,
    outbox,
    repository,
    builder,
    () => NOW,
    () => undefined,
  );
  return { pass, calls, ready };
}

const preparing = { id: EXPORT_ID, kind: 'company', subjectUserId: null } as PrivacyExportRow;

describe('Privacy job — building an export', () => {
  it('stores a clean archive, links it for 7 days, audits and announces it', async () => {
    const { pass, calls, ready } = build();
    expect(await pass.buildOne(context, preparing)).toBe('ready');
    expect(calls).toEqual(['commit', 'privacy_export.ready', 'privacy_export.ready.v1']);
    expect(ready[0]?.['scanStatus']).toBe('clean');
    expect((ready[0]?.['expiresAt'] as Date).toISOString()).toBe('2026-11-01T13:05:00.000Z');
    expect(ready[0]?.['objectKey']).toBe(
      `tenant/${ORG}/privacy-export/${EXPORT_ID}/archive.json.gz`,
    );
  });

  it('throws an infected archive away and fails the export', async () => {
    const { pass, calls, ready } = build({ verdict: 'infected' });
    expect(await pass.buildOne(context, preparing)).toBe('failed');
    expect(calls).toContain('abort');
    expect(calls).not.toContain('commit');
    expect(calls).toContain('failed:malware_detected');
    expect(ready).toEqual([]);
  });

  it('labels the archive not scanned when no scanner is configured', async () => {
    const { pass, ready } = build({ verdict: 'none' });
    expect(await pass.buildOne(context, preparing)).toBe('ready');
    expect(ready[0]?.['scanStatus']).toBe('not_scanned');
  });

  it('leaves the export waiting while the scanner is down', async () => {
    const { pass, calls, ready } = build({ verdict: 'down' });
    expect(await pass.buildOne(context, preparing)).toBe('skipped');
    expect(calls).toEqual([]);
    expect(ready).toEqual([]);
  });
});

describe('Privacy job — carrying out a deletion', () => {
  const account = {
    id: 'r1',
    kind: 'account',
    subjectUserId: OWNER,
    requestedByUserId: OWNER,
    scheduledFor: NOW,
  } as PrivacyDeletionRequestRow;

  it('waits while the person is the only owner', async () => {
    const { pass, calls } = build({ owners: 1 });
    expect(await pass.executeDeletion(context, account)).toBe(false);
    expect(calls).toEqual([]);
  });

  it('offboards a member whose grace period is over', async () => {
    const { pass, calls } = build({ subjectRole: 'member' });
    expect(await pass.executeDeletion(context, account)).toBe(true);
    expect(calls).toEqual([
      'offboard',
      'executed',
      'privacy_deletion.executed',
      'privacy_deletion.changed.v1',
    ]);
  });

  it('closes the company for a company deletion', async () => {
    const { pass, calls } = build();
    const company = {
      ...account,
      kind: 'company',
      subjectUserId: null,
    } as PrivacyDeletionRequestRow;
    expect(await pass.executeDeletion(context, company)).toBe(true);
    expect(calls.slice(0, 2)).toEqual(['close', 'executed']);
  });
});

describe('Privacy job — packing and switches', () => {
  it('packs gzip JSON that reads back the same', () => {
    const document = {
      format: 'tmanage-data-export',
      formatVersion: 1,
      kind: 'member',
      organization: { id: ORG, name: 'Northstar Studio' },
      subjectUserId: OWNER,
      generatedAt: NOW.toISOString(),
      sections: { messages: [{ id: 'm', body: 'hello' }] },
      truncatedSections: [],
    } as ArchiveDocument;
    expect(JSON.parse(gunzipSync(packArchive(document)).toString('utf8'))).toEqual(document);
    expect(archiveFileName('member', NOW)).toBe('tmanage-export-member-2026-10-25.json.gz');
  });

  it('runs in this process only when asked', () => {
    expect(privacyJobEnabled({})).toBe(false);
    expect(privacyJobEnabled({ PRIVACY_JOBS_INPROCESS: '1' })).toBe(true);
    expect(privacyJobEnabled({ WORKER_INPROCESS: '1' })).toBe(true);
  });
});
