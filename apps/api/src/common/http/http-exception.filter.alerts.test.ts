import { describe, expect, it } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import type { Mailer, MailMessage } from '@tmanage/mail';
import { HttpExceptionFilter } from './http-exception.filter.js';
import { ApiError } from './errors.js';
import { AlertNotifier } from '../observability/alerts.js';

function hostFor(url: string): { host: ArgumentsHost; statuses: number[] } {
  const statuses: number[] = [];
  const response = {
    header: () => response,
    status: (code: number) => {
      statuses.push(code);
      return { send: () => undefined };
    },
  };
  const request = { url, method: 'POST' };
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, statuses };
}

function notifier(): { alerts: AlertNotifier; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    send: (m) => {
      sent.push(m);
      return Promise.resolve('sent');
    },
  };
  return { alerts: new AlertNotifier({ recipients: ['ops@example.com'], mailer }), sent };
}

const flush = () => new Promise((done) => setTimeout(done, 0));

describe('HttpExceptionFilter alerts (C10)', () => {
  it('mails the operator on an unhandled 5xx, without the error message or query string', async () => {
    const { alerts, sent } = notifier();
    const { host, statuses } = hostFor('/v1/organizations/acme/work?q=private');
    new HttpExceptionFilter(alerts).catch(new TypeError('detail with pw=hunter2'), host);
    await flush();
    expect(statuses).toEqual([500]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain('http_5xx:unhandled:TypeError');
    expect(sent[0]?.text).toContain('Route: POST /v1/organizations/acme/work\n');
    expect(sent[0]?.text).not.toContain('hunter2');
    expect(sent[0]?.text).not.toContain('private');
  });

  it('does not alert on a 4xx', async () => {
    const { alerts, sent } = notifier();
    const { host } = hostFor('/v1/x');
    new HttpExceptionFilter(alerts).catch(new ApiError(404, 'not_found', 'nope'), host);
    await flush();
    expect(sent).toHaveLength(0);
  });

  it('still renders the response when no notifier is wired', () => {
    const { host, statuses } = hostFor('/v1/x');
    new HttpExceptionFilter().catch(new Error('boom'), host);
    expect(statuses).toEqual([500]);
  });
});
