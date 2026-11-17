import { describe, expect, it } from 'vitest';
import type { MailMessage } from './mailer.js';
import { NotificationMailTransport } from './notification-transport.js';
import { SenderResolvingMailer } from './sender-resolver.js';
import {
  LINK_TOKENS,
  SIGNATURE_TOKENS,
  greeting,
  signOff,
  signOffText,
  stripLinkTokens,
  workspaceReplyLine,
  workspaceSignOff,
} from './sign-off.js';

const ADDRESSES = {
  hello: 'hello@tmanageapp.com',
  support: 'support@tmanageapp.com',
  noreply: 'noreply@tmanageapp.com',
};

function capture() {
  const sent: MailMessage[] = [];
  return {
    sent,
    mailer: {
      send: (message: MailMessage) => {
        sent.push(message);
        return Promise.resolve('sent' as const);
      },
    },
  };
}

describe('EMAILBUILD (c) sign-offs', () => {
  it('[TM] names no person and invites no reply, in both languages', () => {
    for (const language of ['en', 'ar'] as const) {
      const text = signOffText('notice', language);
      expect(text).not.toContain(SIGNATURE_TOKENS.by);
      expect(text).not.toMatch(/reply to this|ردّ على هذه الرسالة/iu);
      expect(text).toContain(LINK_TOKENS.unsubscribe);
    }
  });

  it('welcome is signed by the team; security and support carry no links line', () => {
    expect(signOff('team', 'en')[0]).toBe('The TManage team');
    expect(signOff('team', 'ar')[0]).toBe('فريق TManage');
    expect(signOffText('security', 'en')).not.toContain('[[tm.link');
    expect(signOffText('support', 'ar')).toBe('دعم TManage');
  });

  it('the notification transport fills the links; the resolver drops an unfilled line', async () => {
    const out = capture();
    const transport = new NotificationMailTransport(out.mailer, {
      unsubscribeUrl: 'https://api.example.test/v1/public/email/unsubscribe',
      key: Buffer.alloc(32, 1),
    });
    await transport.send({
      to: 'a@example.test',
      subject: 's',
      text: `Hi\n${signOffText('notice', 'en')}`,
    });
    expect(out.sent[0]?.text).toContain('/v1/public/email/unsubscribe?t=');
    expect(out.sent[0]?.text).not.toContain('[[tm.link');

    const direct = capture();
    const resolver = new SenderResolvingMailer(direct.mailer, {
      identityAddress: 'noreply@tmanageapp.com',
      sendAs: false,
      addresses: ADDRESSES,
    });
    await resolver.send({
      to: 'a@example.test',
      subject: 's',
      templateKey: 'mention',
      text: `Hi\n${signOffText('notice', 'en')}`,
      html: `<p>Hi</p><p style="x">${LINK_TOKENS.settings} | ${LINK_TOKENS.unsubscribe}</p>`,
    });
    expect(direct.sent[0]?.text).toBe(`Hi\n${signOff('notice', 'en', false).join('\n')}`);
    expect(direct.sent[0]?.html).toBe('<p>Hi</p>');
    expect(stripLinkTokens('a\nb', false)).toBe('a\nb');
  });

  it('greeting uses the first name, or a plain hello', () => {
    expect(greeting('en', '  Mariam  Saleh ')).toBe('Hi Mariam,');
    expect(greeting('ar', 'مريم')).toBe('مرحبًا مريم،');
    expect(greeting('en', '')).toBe('Hello,');
  });

  it('agency sign-off keeps the workspace and exactly one reply line', () => {
    const line = workspaceReplyLine('en', 'inviter', { actorName: 'Sara', workspaceName: 'Acme' });
    expect(workspaceSignOff('en', 'Acme', line, 'Sara')).toEqual([
      'Sara, Acme',
      'Sent by TManage on behalf of Acme. Reply to this e-mail to reach Sara.',
    ]);
    expect(workspaceReplyLine('ar', 'none', { workspaceName: 'Acme' })).toBe(
      'الردود على هذه الرسالة لا تُقرأ.',
    );
  });
});
