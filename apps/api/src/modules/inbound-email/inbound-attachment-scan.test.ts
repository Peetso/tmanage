import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeObjectStore } from '@tmanage/storage';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import {
  EICAR,
  NoneScanner,
  ScannerUnavailableError,
  StubScanner,
} from '../../common/scan/malware-scanner.js';
import type { MalwareScanner } from '../../common/scan/malware-scanner.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { runInboundAttachmentPass, sniffPreviewType } from './inbound-attachment-scan.js';
import type { InboundAttachmentsRepository } from './inbound-attachments.repository.js';
import { attachmentObjectKey } from './inbound-mail-rules.js';

/** R22-d — the scan pass: SEC-54-67 (threat), INT-54-42 (scanner down), digest mismatch. */
const ORG = '0192f000-0000-7000-8000-0000000000aa';
const ADDRESS = '0192f000-0000-7000-8000-0000000000ab';
const ATT = '0192f000-0000-7000-8000-0000000000ac';
const KEY = attachmentObjectKey(ORG, ADDRESS, ATT);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(3000, 0x20)]);
const run = (_c: unknown, work: (r: never) => unknown) => work({} as never);
const db = { read: run, transaction: run, bootstrapRead: run } as unknown as TenantDatabase;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function harness(bytes: Buffer, scanner: MalwareScanner, digest = sha(bytes)) {
  const row: Record<string, unknown> = {
    id: ATT,
    inboundEmailId: 'mail-1',
    addressId: ADDRESS,
    name: 'brief.pdf',
    sizeBytes: bytes.length,
    sha256: digest,
    detectedType: null,
    updatedAt: new Date('2026-11-02T00:00:00Z'),
    state: 'scanning',
    scanStatus: null,
  };
  const store = new FakeObjectStore(() => 0);
  store.objects.set(`quarantine/${KEY}`, bytes);
  const conclude =
    (state: string) =>
    (_t: never, _c: never, _id: string, f?: { detectedType?: string | null }) => {
      Object.assign(row, { state, detectedType: f?.detectedType ?? row['detectedType'] });
      return Promise.resolve(true);
    };
  const repository = {
    organizationsAwaitingScan: () => Promise.resolve(row['state'] === 'scanning' ? [ORG] : []),
    listAwaitingScan: () =>
      Promise.resolve(row['state'] === 'scanning' && row['scanStatus'] === null ? [row] : []),
    claimScanning: () => Promise.resolve(void (row['scanStatus'] = 'claimed')).then(() => true),
    recordClean: conclude('clean'),
    recordThreat: conclude('blocked_threat'),
    markUnavailable: conclude('unavailable'),
  } as unknown as InboundAttachmentsRepository;
  const audits: string[] = [];
  const events: string[] = [];
  const audit = {
    record: (_t: never, _c: never, e: { action: string }) =>
      Promise.resolve(void audits.push(e.action)),
  } as unknown as AuditService;
  const outbox = {
    append: (_t: never, _c: never, e: { type: string }) =>
      Promise.resolve(void events.push(e.type)),
  } as unknown as OutboxEventsRepository;
  const pass = () =>
    runInboundAttachmentPass({
      database: db,
      store,
      scanner,
      repository,
      audit,
      outbox,
      log: () => undefined,
    });
  return { row, store, audits, events, pass };
}

describe('runInboundAttachmentPass (R22-d)', () => {
  it('a clean PDF becomes clean: the private object exists and the quarantine copy is gone', async () => {
    const h = harness(PDF, new StubScanner());
    const report = await h.pass();
    expect(report).toMatchObject({ scanned: 1, clean: 1, infected: 0 });
    expect(h.row['state']).toBe('clean');
    expect(h.row['detectedType']).toBe('application/pdf');
    expect(h.store.objects.get(`private/${KEY}`)?.equals(PDF)).toBe(true);
    expect(h.store.objects.has(`quarantine/${KEY}`)).toBe(false);
    expect(h.audits).toEqual(['inbound_email.attachment_clean']);
  });

  it('EICAR bytes are blocked_threat with no private object and one outbox event (SEC-54-67)', async () => {
    const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), EICAR]);
    const h = harness(bytes, new StubScanner());
    const report = await h.pass();
    expect(report).toMatchObject({ infected: 1, clean: 0 });
    expect(h.row['state']).toBe('blocked_threat');
    expect(h.store.objects.has(`private/${KEY}`)).toBe(false);
    expect(h.store.objects.has(`quarantine/${KEY}`)).toBe(false);
    expect(h.events).toEqual(['inbound_email.attachment_blocked.v1']);
  });

  it('a scanner that is unreachable leaves the row scanning and promotes nothing (INT-54-42)', async () => {
    const down: MalwareScanner = {
      name: 'clamav',
      kind: 'engine',
      probe: () => Promise.resolve(),
      scan: () => Promise.reject(new ScannerUnavailableError('refused')),
    };
    const h = harness(PDF, down);
    const report = await h.pass();
    expect(report.unavailable).toBe(1);
    expect(h.row['state']).toBe('scanning');
    expect(h.store.committed).toEqual([]);
    expect(h.store.objects.has(`quarantine/${KEY}`)).toBe(true);
  });

  it('bytes whose digest is not the parked one are unavailable, never a verdict', async () => {
    const h = harness(PDF, new StubScanner(), sha(Buffer.from('other')));
    const report = await h.pass();
    expect(report).toMatchObject({ unavailable: 1, errors: 1, clean: 0 });
    expect(h.row['state']).toBe('unavailable');
    expect(h.store.committed).toEqual([]);
  });

  it('the none scanner claims nothing, so nothing is ever clean (rule 3)', async () => {
    const h = harness(PDF, new NoneScanner());
    expect(await h.pass()).toMatchObject({ scanned: 0, clean: 0 });
    expect(h.row['state']).toBe('scanning');
    expect(sniffPreviewType(Buffer.from('PK\u0003\u0004'))).toBeNull();
  });
});
