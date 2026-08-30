import { describe, expect, it, vi } from 'vitest';
import { ConsoleMailer } from './console-mailer.js';

/**
 * The shipped default: `EMAIL_DRIVER=console`, the driver every development environment
 * runs. The first review of this slice found it completely untested — and misbehaving
 * upstream, where its honest `'none'` was being audited as an error. The upstream rule now
 * lives in `InvitationsService` (`'none'` writes no audit row); what this file pins is the
 * driver's own half of the contract.
 */

describe('ConsoleMailer', () => {
  it('prints the whole message and answers none — printing is not delivery', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const mailer = new ConsoleMailer({
        fromAddress: 'no-reply@tmanage.example',
        fromName: 'TManage',
      });

      const delivery = await mailer.send({
        to: 'nadia@brightops.example',
        subject: 'Omar invited you to Northstar Studio on TManage',
        text: 'Review invitation: https://app.tmanage.example/invitations/tok123',
      });

      expect(delivery).toBe('none');
      expect(spy).toHaveBeenCalledTimes(1);
      const printed = String(spy.mock.calls[0]?.[0]);
      expect(printed).toContain('nothing was sent');
      expect(printed).toContain('To: nadia@brightops.example');
      expect(printed).toContain('Subject: Omar invited you to Northstar Studio on TManage');
      // The link is the point of running this driver locally: the developer needs to see it.
      expect(printed).toContain('https://app.tmanage.example/invitations/tok123');
    } finally {
      spy.mockRestore();
    }
  });
});
