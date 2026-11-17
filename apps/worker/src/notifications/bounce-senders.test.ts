import { describe, expect, it } from 'vitest';
import {
  BounceGuardMailer,
  bounceMessageId,
  deriveBounceKey,
  emailAddressHash,
  readBounceMessageId,
} from '@tmanage/mail';
import type { MailDelivery, MailMessage } from '@tmanage/mail';
import { ClientRequestMailer } from './client-request-mailer.js';
import { DigestMailer } from './digest-mailer.js';
import { PrivacyMailer } from './privacy-mailer.js';
import { StorageRootMailer } from './storage-root-mailer.js';
import { UsageThresholdMailer } from './usage-threshold-mailer.js';
import type { ClientRequestMailFacts } from '../common/database/mail-store.js';

const ORG = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const TO = 'dana@atlas.example';
const KEY = deriveBounceKey('k'.repeat(48));

/** A guard over a recording transport; `suppressed` flips the company's answer. */
function world() {
  const sent: MailMessage[] = [];
  const state = { suppressed: false };
  const mailer = new BounceGuardMailer(
    { send: (m: MailMessage): Promise<MailDelivery> => (sent.push(m), Promise.resolve('sent')) },
    {
      isBounceSuppressed: (org, hash) =>
        Promise.resolve(state.suppressed && org === ORG && hash === emailAddressHash(TO)),
    },
    () => undefined,
  );
  return { sent, state, mailer };
}

/** The Message-ID the SMTP driver signs for this message names our company and recipient. */
function expectSigned(message: MailMessage | undefined): void {
  expect(message?.organizationId).toBe(ORG);
  const id = bounceMessageId(KEY, {
    organizationId: message?.organizationId as string,
    to: message?.to as string,
    domain: 'tm.io',
  }) as string;
  expect(readBounceMessageId(KEY, id)).toMatchObject({
    organizationId: ORG,
    addressHash: emailAddressHash(TO),
  });
}

const REQUEST: ClientRequestMailFacts = {
  recipientEmail: TO,
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
  clientVisibleReason: null,
};

/**
 * 56-26: each worker sender family names its company (so the Message-ID is signed for it), and a
 * recipient suppressed in that company ends in the sender's own calm `'failed'` — `deliver` never
 * throws, so the outbox event that staged it is done and is never retried.
 */
describe('56-26 worker company mail and bounces', () => {
  const families: readonly [
    string,
    (mailer: BounceGuardMailer) => Promise<MailDelivery | 'failed'>,
  ][] = [
    [
      'client portal (request updates)',
      (m) => new ClientRequestMailer(m, 'https://tm.test').deliver('accepted', 'r1', REQUEST, ORG),
    ],
    [
      'notifications (usage, storage at risk)',
      async (m) => {
        const usage = await new UsageThresholdMailer(m).deliver({
          organizationId: ORG,
          recipientEmail: TO,
          recipientName: 'Dana',
          band: 90,
          used: 9,
          reserved: 0,
          quota: 10,
        });
        const root = await new StorageRootMailer(m).deliver({
          organizationId: ORG,
          recipientEmail: TO,
          recipientName: 'Dana',
          provider: 'google_drive',
          reason: 'holder_offboarded',
        });
        return usage === root ? usage : 'failed';
      },
    ],
    [
      'digest',
      (m) =>
        new DigestMailer(m, 'https://tm.test').deliver({
          organizationId: ORG,
          recipientEmail: TO,
          recipientName: 'Dana',
          organizationName: 'Northwind',
          cadence: 'daily',
          counts: { mention: 2 },
          inboxLink: 'https://tm.test/inbox',
          settingsLink: 'https://tm.test/settings',
        }),
    ],
    [
      'privacy notices',
      (m) =>
        new PrivacyMailer(m, 'https://tm.test').deliver('export_ready', {
          organizationId: ORG,
          recipientEmail: TO,
          recipientName: 'Dana',
          locale: 'en',
          organizationName: 'Northwind',
          scope: 'member',
          link: 'https://tm.test/northwind/settings/my-data',
        }),
    ],
  ];

  for (const [family, deliver] of families) {
    it(`${family}: signed for the company; a suppressed address fails quietly`, async () => {
      const w = world();
      await expect(deliver(w.mailer)).resolves.toBe('sent');
      expect(w.sent.length).toBeGreaterThan(0);
      for (const message of w.sent) expectSigned(message);

      const before = w.sent.length;
      w.state.suppressed = true;
      await expect(deliver(w.mailer)).resolves.toBe('failed');
      expect(w.sent).toHaveLength(before);
    });
  }
});
