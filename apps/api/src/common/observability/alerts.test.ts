import { describe, expect, it } from 'vitest';
import type { Mailer, MailMessage } from '@tmanage/mail';
import { ALERT_WINDOW_MS, AlertNotifier, parseAlertEmails, renderAlert } from './alerts.js';

function recordingMailer(fail = false): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    send(message) {
      if (fail) return Promise.reject(new Error('smtp down: password=hunter2'));
      sent.push(message);
      return Promise.resolve('sent');
    },
  };
}

describe('parseAlertEmails', () => {
  it('lower-cases, de-duplicates and drops junk', () => {
    expect(parseAlertEmails(' Owner@Example.com, owner@example.com ,nope, ,b@x.io')).toEqual([
      'owner@example.com',
      'b@x.io',
    ]);
    expect(parseAlertEmails(undefined)).toEqual([]);
  });
});

describe('AlertNotifier', () => {
  it('is off when ALERT_EMAILS names nobody, or there is no mail transport', async () => {
    const mailer = recordingMailer();
    expect(await new AlertNotifier({ recipients: [], mailer }).notify('http_5xx:x')).toBe('off');
    expect(
      await new AlertNotifier({ recipients: ['a@b.co'], mailer: null }).notify('http_5xx:x'),
    ).toBe('off');
    expect(mailer.sent).toHaveLength(0);
  });

  it('mails every recipient, then at most once per 15 minutes per kind', async () => {
    let now = 1_000_000;
    const mailer = recordingMailer();
    const alerts = new AlertNotifier({
      recipients: ['a@b.co', 'c@d.co'],
      mailer,
      now: () => now,
    });

    expect(
      await alerts.notify('http_5xx:unhandled:TypeError', { route: '/v1/x?token=secret' }),
    ).toBe('sent');
    expect(mailer.sent.map((m) => m.to)).toEqual(['a@b.co', 'c@d.co']);
    expect(mailer.sent[0]?.text).toContain('Route: /v1/x\n');
    expect(mailer.sent[0]?.text).not.toContain('secret');

    now += ALERT_WINDOW_MS - 1;
    expect(await alerts.notify('http_5xx:unhandled:TypeError')).toBe('throttled');
    expect(await alerts.notify('http_5xx:unhandled:TypeError')).toBe('throttled');
    // A different kind is not held back by the first one.
    expect(await alerts.notify('job_failed:outbox')).toBe('sent');
    expect(mailer.sent).toHaveLength(4);

    now += 1;
    expect(await alerts.notify('http_5xx:unhandled:TypeError')).toBe('sent');
    expect(mailer.sent[4]?.text).toContain('Held back since the last alert of this kind: 2');
  });

  it('never throws when the mail transport fails, and never logs the error message', async () => {
    const lines: string[] = [];
    const alerts = new AlertNotifier({
      recipients: ['a@b.co'],
      mailer: recordingMailer(true),
      log: (line) => lines.push(line),
    });
    expect(await alerts.notify('job_failed:outbox')).toBe('failed');
    expect(lines.join('\n')).not.toContain('hunter2');
  });
});

describe('renderAlert', () => {
  it('carries the kind, time and correlation id, and no message body', () => {
    const mail = renderAlert(
      'http_5xx:unhandled:Error',
      { correlationId: 'c-1', errorName: 'Error' },
      new Date('2026-10-25T10:00:00.000Z'),
      0,
    );
    expect(mail.subject).toBe(
      '[TManage alert] A request failed with a server error: http_5xx:unhandled:Error',
    );
    expect(mail.text).toContain('Time (UTC): 2026-10-25T10:00:00.000Z');
    expect(mail.text).toContain('Correlation id: c-1');
  });
});
