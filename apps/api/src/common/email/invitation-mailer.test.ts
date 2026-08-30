import { describe, expect, it, vi } from 'vitest';
import { InvitationMailer } from './invitation-mailer.js';
import type { InvitationDeliveryFacts } from './invitation-mailer.js';
import type { MailDelivery, Mailer, MailMessage } from './mailer.js';

/**
 * The producer-side contract: `deliver` answers `'sent'`, `'none'` or `'failed'` and never
 * throws, because the invitation it describes is already committed and the printed link is
 * the fallback. The database suite proves the same thing through a real request; this file
 * proves the three answers and the link, without a server.
 */

class RecordingMailer implements Mailer {
  readonly messages: MailMessage[] = [];

  send(message: MailMessage): Promise<MailDelivery> {
    this.messages.push(message);
    return Promise.resolve('sent');
  }
}

const facts = (): InvitationDeliveryFacts => ({
  to: 'nadia@brightops.example',
  clientOrganizationName: null,
  organizationName: 'Northstar Studio',
  inviterName: 'Omar Farouk',
  inviterEmail: 'omar@northstar.example',
  role: 'producer',
  expiresAt: new Date('2026-09-13T10:00:00.000Z'),
  token: 'tok123',
});

describe('InvitationMailer', () => {
  it('answers none, and composes nothing, when no transport exists', async () => {
    const mailer = new InvitationMailer(null, '');

    expect(mailer.enabled).toBe(false);
    await expect(mailer.deliver(facts())).resolves.toBe('none');
  });

  it('builds the accept link from the configured web origin, not from any request', async () => {
    const transport = new RecordingMailer();
    // The trailing slash is the shape a copy-pasted origin actually has.
    const mailer = new InvitationMailer(transport, 'https://app.tmanage.example/');

    await expect(mailer.deliver(facts())).resolves.toBe('sent');
    expect(transport.messages).toHaveLength(1);
    expect(transport.messages[0]?.text).toContain('https://app.tmanage.example/invitations/tok123');
    expect(transport.messages[0]?.to).toBe('nadia@brightops.example');
  });

  it('answers failed, without throwing, when the transport throws', async () => {
    const broken: Mailer = {
      send: () => Promise.reject(new Error('connection refused')),
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const mailer = new InvitationMailer(broken, 'https://app.tmanage.example');

      await expect(mailer.deliver(facts())).resolves.toBe('failed');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
