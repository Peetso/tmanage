import { describe, expect, it, vi } from 'vitest';
import type { MailDelivery, Mailer, MailMessage } from '@tmanage/mail';
import { ClientRequestMailer, mailKindForStatus } from './client-request-mailer.js';
import type { ClientRequestMailFacts } from '../common/database/mail-store.js';

const FACTS: ClientRequestMailFacts = {
  recipientEmail: 'dana@atlas.example',
  recipientName: 'Dana Client',
  organizationName: 'Northwind Studio',
  organizationSlug: 'northwind',
  projectName: 'Spring Campaign',
  title: 'New landing page',
  desiredAt: '2026-09-30',
  committedAt: null,
  commitment: null,
  hasClarificationQuestion: false,
  clientSafeScopeSummary: null,
};

class RecordingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  send(message: MailMessage): Promise<MailDelivery> {
    this.sent.push(message);
    return Promise.resolve('sent');
  }
}

class ThrowingMailer implements Mailer {
  send(): Promise<MailDelivery> {
    return Promise.reject(new Error('ECONNREFUSED smtp.example:587'));
  }
}

describe('mailKindForStatus', () => {
  it('maps the two destination states §3 writes copy for', () => {
    expect(mailKindForStatus('needs_clarification')).toBe('clarification');
    expect(mailKindForStatus('accepted')).toBe('accepted');
  });

  it('mails nothing for every other legal destination', () => {
    // `23-ERD` §6's other destinations. Each notifies in-app; none has an §3 template.
    for (const status of ['triage', 'deferred', 'declined', 'planned', 'delivered', 'withdrawn']) {
      expect(mailKindForStatus(status), status).toBeNull();
    }
  });

  it('is not fooled by a prototype key arriving as a status', () => {
    expect(mailKindForStatus('constructor')).toBeNull();
    expect(mailKindForStatus('toString')).toBeNull();
  });
});

describe('ClientRequestMailer', () => {
  it('builds the portal link from configuration and the request id', () => {
    const mailer = new ClientRequestMailer(new RecordingMailer(), 'https://app.example');
    const message = mailer.compose('received', 'req-7', FACTS);
    expect(message.text).toContain('https://app.example/northwind/portal/requests/req-7');
  });

  it('does not double the slash when the configured origin has a trailing one', () => {
    const mailer = new ClientRequestMailer(new RecordingMailer(), 'https://app.example///');
    const message = mailer.compose('received', 'req-7', FACTS);
    expect(message.text).toContain('https://app.example/northwind/portal/requests/req-7');
    expect(message.text).not.toContain('example//northwind');
  });

  it('answers none and composes nothing with no transport wired', async () => {
    const mailer = new ClientRequestMailer(null, 'https://app.example');
    expect(mailer.enabled).toBe(false);
    await expect(mailer.deliver('received', 'req-7', FACTS)).resolves.toBe('none');
  });

  it('sends the composed message through the port and reports what happened', async () => {
    const transport = new RecordingMailer();
    const mailer = new ClientRequestMailer(transport, 'https://app.example');
    expect(mailer.enabled).toBe(true);
    await expect(mailer.deliver('accepted', 'req-7', FACTS)).resolves.toBe('sent');
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.subject).toBe('Request accepted: New landing page');
    expect(transport.sent[0]?.to).toBe('dana@atlas.example');
  });

  it('absorbs a transport failure — it runs where nothing can be rolled back', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mailer = new ClientRequestMailer(new ThrowingMailer(), 'https://app.example');
    await expect(mailer.deliver('clarification', 'req-7', FACTS)).resolves.toBe('failed');
    expect(logged).toHaveBeenCalledOnce();
    // The driver's words may name the recipient. They go to the operator's log, and the
    // line itself names the request rather than the address.
    expect(String(logged.mock.calls[0]?.[0])).toContain('req-7');
    expect(String(logged.mock.calls[0]?.[0])).not.toContain('dana@atlas.example');
    logged.mockRestore();
  });
});
