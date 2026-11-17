import 'reflect-metadata';
import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FakeObjectStore } from '@tmanage/storage';
import type { Principal } from '@tmanage/domain';
import type { MailMessage } from '@tmanage/mail';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuditEventsRepository } from '../audit/audit-events.repository.js';
import { InboundAttachmentsController, respond } from './inbound-attachments.controller.js';
import { InboundAttachmentsService } from './inbound-attachments.service.js';
import type { InboundAttachmentsRepository } from './inbound-attachments.repository.js';
import type { InboundEmailRepository } from './inbound-email.repository.js';
import { attachmentObjectKey } from './inbound-mail-rules.js';

/** R22-d — SEC-54-66/68, AUTH-54-69, ask-resend; the five preview headers. */
const ORG = '0192f000-0000-7000-8000-0000000000aa';
const ADDRESS = '0192f000-0000-7000-8000-0000000000ab';
const ATT = '0192f000-0000-7000-8000-0000000000ac';
const NOW = new Date('2026-11-02T12:00:00.000Z');
const run = (_c: unknown, work: (r: never) => unknown) => work({} as never);
const db = { read: run, transaction: run } as unknown as TenantDatabase;
const context = { organizationId: ORG, correlationId: 'c', userId: 'u-1' } as TenantContext;
const owner = {
  userId: 'u-1',
  organizationId: ORG,
  kind: 'internal',
  role: 'org_admin',
  membershipId: 'm-1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
} as Principal;
const member = { ...owner, role: 'member', hasOrgWideScope: false } as Principal;
const client = {
  ...owner,
  kind: 'client',
  role: 'client_admin',
  clientOrganizationId: 'co-1',
} as unknown as Principal;

function harness(
  state: string,
  detectedType: string | null,
  mailStates: string[] = [],
  lastAsk?: Date,
) {
  const store = new FakeObjectStore(() => 0);
  store.objects.set(`private/${attachmentObjectKey(ORG, ADDRESS, ATT)}`, Buffer.from('bytes'));
  const row = {
    id: ATT,
    inboundEmailId: 'mail-1',
    addressId: ADDRESS,
    name: 'a "b".png',
    sizeBytes: 5,
    state,
    detectedType,
    authResult: 'pass',
  };
  const repo = {
    findForServe: () => Promise.resolve(row),
  } as unknown as InboundAttachmentsRepository;
  const mails = {
    findEmail: () =>
      Promise.resolve({
        id: 'mail-1',
        fromEmail: 'Ann <ann@client.test>',
        subject: 'Files http://x.test',
      }),
    listAttachments: () =>
      Promise.resolve(mailStates.map((s, i) => ({ state: s, name: `f${i}.docm` }))),
    findActiveAddress: () => Promise.resolve({ localPart: 'requests+acme-ab12cd' }),
    organizationLabel: () => Promise.resolve({ name: 'Acme Studio', defaultLocale: 'en' }),
  } as unknown as InboundEmailRepository;
  const audits: string[] = [];
  const audit = {
    record: (_t: never, _c: never, e: { action: string }) =>
      Promise.resolve(void audits.push(e.action)),
    recordStandalone: (_c: never, e: { action: string }) =>
      Promise.resolve(void audits.push(e.action)),
  } as unknown as AuditService;
  const events = {
    list: () => Promise.resolve(lastAsk ? [{ createdAt: lastAsk }] : []),
  } as unknown as AuditEventsRepository;
  const sent: MailMessage[] = [];
  const mailer = {
    send: (m: MailMessage) => Promise.resolve(void sent.push(m)).then(() => 'sent' as const),
  };
  const service = new InboundAttachmentsService(
    db,
    repo,
    mails,
    store,
    audit,
    mailer,
    events,
    () => NOW,
  );
  return { service, audits, sent };
}

async function status(work: Promise<unknown>): Promise<number> {
  try {
    await work;
    return 200;
  } catch (error) {
    return (error as { status: number }).status;
  }
}

describe('InboundAttachmentsService (R22-d)', () => {
  it('a scanning or waiting_trust row previews 404 (SEC-54-66)', async () => {
    expect(
      await status(harness('scanning', 'image/png').service.preview(context, owner, ATT)),
    ).toBe(404);
    expect(
      await status(harness('waiting_trust', 'image/png').service.preview(context, owner, ATT)),
    ).toBe(404);
  });

  it('a clean PNG preview carries inline and the sandbox headers (SEC-54-68)', async () => {
    const served = await harness('clean', 'image/png').service.preview(context, owner, ATT);
    const headers: Record<string, string> = {};
    respond(served, { header: (n: string, v: string) => (headers[n] = v) }, 'inline');
    expect(headers['content-disposition']).toMatch(/^inline; filename="a _b_.png"/u);
    expect(headers).toMatchObject({
      'content-type': 'image/png',
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'cross-origin-resource-policy': 'same-site',
    });
  });

  it('a clean DOCX previews 404 but downloads as an attachment with one audit row', async () => {
    const h = harness('clean', null);
    expect(await status(h.service.preview(context, owner, ATT))).toBe(404);
    const served = await h.service.download(context, owner, ATT);
    const headers: Record<string, string> = {};
    respond(served, { header: (n: string, v: string) => (headers[n] = v) }, 'attachment');
    expect(headers['content-disposition']).toMatch(/^attachment;/u);
    expect(h.audits).toEqual(['inbound_email.attachment_downloaded']);
    (served.stream as Readable).destroy();
  });

  it('refuses a member without client_request.triage (AUTH-54-69) and a client everywhere', async () => {
    const h = harness('clean', 'image/png', ['blocked_type']);
    expect(await status(h.service.preview(context, member, ATT))).toBe(403);
    expect(await status(h.service.preview(context, client, ATT))).toBe(403);
    expect(await status(h.service.download(context, client, ATT))).toBe(403);
    expect(await status(h.service.askResend(context, client, 'mail-1'))).toBe(403);
  });

  it('ask-resend: 409 with only clean rows, 429 within 24 h, the mail names the file and has no URL', async () => {
    expect(
      await status(harness('clean', null, ['clean']).service.askResend(context, owner, 'mail-1')),
    ).toBe(409);
    const recent = new Date(NOW.getTime() - 60_000);
    expect(
      await status(
        harness('clean', null, ['too_large'], recent).service.askResend(context, owner, 'mail-1'),
      ),
    ).toBe(429);
    const h = harness('clean', null, ['clean', 'blocked_type']);
    expect(await h.service.askResend(context, owner, 'mail-1')).toMatchObject({
      delivery: 'sent',
      attachments: 1,
    });
    const mail = h.sent[0] as MailMessage;
    expect(mail.to).toBe('ann@client.test');
    expect(mail.text).toContain('f1.docm');
    expect(mail.text).toContain('Acme Studio received your e-mail');
    expect(mail.text).toContain('Sent by TManage on behalf of Acme Studio.');
    expect(`${mail.subject}\n${mail.text}`).not.toMatch(/https?:|:\/\//u);
    expect(h.audits).toEqual(['inbound_email.ask_resend']);
  });

  it('every route carries its capability', () => {
    const proto = InboundAttachmentsController.prototype as unknown as Record<string, object>;
    const caps = ['preview', 'download', 'askResend'].map((name) =>
      Reflect.getMetadataKeys(proto[name] as object)
        .map((key: unknown) => Reflect.getMetadata(key, proto[name] as object) as unknown)
        .find((v) => typeof v === 'string' && v.includes('.')),
    );
    expect(caps).toEqual(['client_request.triage', 'file.download', 'client_request.triage']);
  });
});
