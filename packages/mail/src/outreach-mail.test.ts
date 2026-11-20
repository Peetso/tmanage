import { describe, expect, it } from 'vitest';
import { createIdentityMailers } from './identity-mailer.js';
import { deriveUnsubscribeKey } from './list-unsubscribe.js';
import type { MailDelivery, MailMessage } from './mailer.js';
import { SenderResolvingMailer } from './sender-resolver.js';
import { LINK_TOKENS } from './sign-off.js';
import type { SmtpMailerOptions } from './smtp-mailer.js';
import {
  TRIAL_LINK_TTL_MS,
  deriveTrialLinkKey,
  readTrialLink,
  signTrialLink,
  verifyTrialLink,
} from './trial-link.js';

/**
 * LANE-Q — the two new senders and the trial link.
 *
 * - `walkthrough_request` leaves through the sales@ mailbox's own login (shared password), and
 *   the visitor's address is its Reply-To only when it is one plain address.
 * - `campaign_intro` with a `campaign` person reference leaves from that person's own mailbox
 *   (ADR-0013), carries the RFC 8058 pair, and its own personal unsubscribe line is filled in
 *   place: no second, generic footer is added.
 * - The trial link verifies only for the row it was minted for, and expires after 30 days.
 */

const SHARED = 'Shared-Mailbox-pa55!';
const base: SmtpMailerOptions = {
  host: 'smtp.example',
  port: 465,
  secure: true,
  username: 'noreply@tmanageapp.com',
  password: SHARED,
  fromAddress: 'noreply@tmanageapp.com',
  fromName: 'TManage',
};

function harness() {
  const sent: { login: string | undefined; message: MailMessage }[] = [];
  const router = createIdentityMailers({
    base,
    build: (smtp) => ({
      send(message: MailMessage): Promise<MailDelivery> {
        sent.push({ login: smtp.username, message });
        return Promise.resolve('sent');
      },
    }),
    hello: { address: 'hello@tmanageapp.com' },
    support: { address: 'support@tmanageapp.com' },
    sales: { address: 'sales@tmanageapp.com' },
    log: () => undefined,
  });
  const resolver = new SenderResolvingMailer(router, {
    identityAddress: 'noreply@tmanageapp.com',
    sendAs: false,
    addresses: {
      hello: 'hello@tmanageapp.com',
      support: 'support@tmanageapp.com',
      noreply: 'noreply@tmanageapp.com',
      sales: 'sales@tmanageapp.com',
    },
    directory: {
      personFor: (_org, ref) =>
        Promise.resolve(
          ref.kind === 'campaign' && ref.personId === 'p-1'
            ? { name: 'Mariam', role: 'onboarding', address: 'mariam@tmanageapp.com' }
            : null,
        ),
    },
    unsubscribe: {
      url: 'https://api.tmanageapp.com/v1/public/email/unsubscribe',
      key: deriveUnsubscribeKey('suite-secret'),
    },
    log: () => undefined,
  });
  return { resolver, sent };
}

describe('LANE-Q — sales@ sends the walkthrough request', () => {
  it('signs in as sales@, From sales@, Reply-To the visitor', async () => {
    const h = harness();
    await h.resolver.send({
      to: 'sales@tmanageapp.com',
      subject: 'Walkthrough request',
      text: 'body',
      templateKey: 'walkthrough_request',
      replyTo: 'visitor@agency.example',
    });
    const last = h.sent.at(-1);
    expect(last?.login).toBe('sales@tmanageapp.com');
    expect(last?.message.identity).toBe('sales');
    expect(last?.message.replyTo).toBe('visitor@agency.example');
  });

  it('drops a Reply-To that is not one plain address (no header tricks)', async () => {
    const h = harness();
    await h.resolver.send({
      to: 'sales@tmanageapp.com',
      subject: 'Walkthrough request',
      text: 'body',
      templateKey: 'walkthrough_request',
      replyTo: 'a@b.example\r\nBcc: x@y.example',
    });
    expect(h.sent.at(-1)?.message.replyTo).toBe('sales@tmanageapp.com');
  });
});

describe('LANE-Q — the campaign e-mail leaves from the assigned person', () => {
  it('signs in as the person own address and fills the personal unsubscribe line only', async () => {
    const h = harness();
    await h.resolver.send({
      to: 'lead@agency.example',
      subject: 'Client approvals without the email chase',
      text: `Hi Sam,\n\nBest,\nMariam\n\nIf this isn't relevant: ${LINK_TOKENS.unsubscribe}`,
      templateKey: 'campaign_intro',
      personRef: { kind: 'campaign', personId: 'p-1' },
    });
    const last = h.sent.at(-1);
    expect(last?.login).toBe('mariam@tmanageapp.com');
    expect(last?.message.from).toEqual({
      name: 'Mariam from TManage',
      address: 'mariam@tmanageapp.com',
    });
    expect(last?.message.replyTo).toBe('mariam@tmanageapp.com');
    expect(last?.message.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const text = last?.message.text ?? '';
    expect(text).toMatch(/If this isn't relevant: https:\/\/api\.tmanageapp\.com\/v1\/public\//u);
    expect(text).not.toContain('Notification settings');
    expect(text).not.toContain('[[tm.');
  });
});

describe('LANE-Q — trial link', () => {
  const key = deriveTrialLinkKey('suite-secret');
  const subject = {
    recipientId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b',
    email: 'Lead@Agency.example',
    company: 'Atlas Studio',
  };
  const now = new Date('2026-11-20T10:00:00Z');

  it('verifies for its row, and only until the 30 days are over', () => {
    const token = signTrialLink(key, subject, now);
    expect(readTrialLink(token)?.recipientId).toBe(subject.recipientId);
    expect(verifyTrialLink(key, token, subject, now)).toBe('valid');
    const later = new Date(now.getTime() + TRIAL_LINK_TTL_MS + 1000);
    expect(verifyTrialLink(key, token, subject, later)).toBe('expired');
  });

  it('refuses a token whose row changed, another key, or a tampered expiry', () => {
    const token = signTrialLink(key, subject, now);
    expect(verifyTrialLink(key, token, { ...subject, company: 'Other' }, now)).toBe('invalid');
    expect(verifyTrialLink(key, token, { ...subject, email: 'x@y.example' }, now)).toBe('invalid');
    expect(verifyTrialLink(deriveTrialLinkKey('other'), token, subject, now)).toBe('invalid');
    const [v, id, exp, sig] = token.split('.');
    const pushed = `${v ?? ''}.${id ?? ''}.${String(Number(exp) + 86_400)}.${sig ?? ''}`;
    expect(verifyTrialLink(key, pushed, subject, now)).toBe('invalid');
    expect(readTrialLink('v1.not-an-id.1.x')).toBeNull();
  });
});
