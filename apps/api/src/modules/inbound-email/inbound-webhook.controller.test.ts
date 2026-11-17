import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { InboundEmailService } from './inbound-email.service.js';
import { InboundWebhookController, captureInboundRawBody } from './inbound-webhook.controller.js';
import { MAX_WEBHOOK_BODY_BYTES } from './inbound-mail-rules.js';

/** R22-c — the signed JSON inbound webhook: secret gate, signature, body limit. */
const SECRET = 'k'.repeat(40);
const NOW = new Date('2026-11-02T12:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const BODY = JSON.stringify({ to: 'requests+a-ab12cd@tmanageapp.com', from: 'm@a.com' });

const sign = (body: string, ts = TS) =>
  `v1=${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`;

function controller(secret: string | null = SECRET) {
  const ingest = vi.fn(() => Promise.resolve({ status: 'work_item' as const }));
  const service = { ingest } as unknown as InboundEmailService;
  return { ingest, ctl: new InboundWebhookController(service, { secret, now: () => NOW }) };
}

const request = (body: string, signature: string, ts = TS) => ({
  headers: { 'x-inbound-signature': signature, 'x-inbound-timestamp': ts },
  rawBody: Buffer.from(body),
});

describe('InboundWebhookController (R22-c)', () => {
  it('accepts a correct signature within 300 s and answers the ingest status', async () => {
    const { ctl, ingest } = controller();
    expect(await ctl.receive(request(BODY, sign(BODY)))).toEqual({ status: 'work_item' });
    expect(ingest).toHaveBeenCalledOnce();
  });

  it('answers 401 for a stale timestamp or a signature over another body', async () => {
    const { ctl, ingest } = controller();
    const stale = String(Number(TS) - 301);
    await expect(ctl.receive(request(BODY, sign(BODY, stale), stale))).rejects.toMatchObject({
      status: 401,
    });
    await expect(ctl.receive(request(BODY, sign('{"other":1}')))).rejects.toMatchObject({
      status: 401,
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('answers 404 with no secret configured and never calls ingest', async () => {
    const { ctl, ingest } = controller(null);
    await expect(ctl.receive(request(BODY, sign(BODY)))).rejects.toMatchObject({ status: 404 });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('answers 422 for a signed body that is not a valid message', async () => {
    const { ctl } = controller();
    await expect(ctl.receive(request('[1]', sign('[1]')))).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a 10 MiB + 1 body with 413 before parsing', async () => {
    const big = Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1, 0x20);
    const req: { url: string; rawBody?: Buffer } = { url: '/v1/public/inbound-email/webhook' };
    await expect(captureInboundRawBody(req, null, Readable.from([big]))).rejects.toMatchObject({
      statusCode: 413,
    });
    expect(req.rawBody).toBeUndefined();
  });
});
