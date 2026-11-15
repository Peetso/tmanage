import type { MailMessage } from '@tmanage/mail';
import { renderActionEmail } from '../../common/email/action-email.js';
import { SUPPORT_REPLY_TO } from './support.policy.js';

/**
 * 55-17 — the e-mail a person receives when the TManage team answers their support conversation.
 * It names the subject and carries one link back into the app (the panel opens on the thread);
 * the reply text itself stays in the app. Replies to the mail go to {@link SUPPORT_REPLY_TO}.
 */

export interface SupportReplyFacts {
  readonly to: string;
  readonly subject: string;
  readonly organizationSlug: string;
  readonly threadId: string;
  readonly webPublicUrl: string;
}

export function supportThreadLink(webPublicUrl: string, slug: string, threadId: string): string {
  const base = webPublicUrl.replace(/\/+$/u, '');
  return `${base}/${encodeURIComponent(slug)}/help?request=${encodeURIComponent(threadId)}`;
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').trim();
}

export function buildSupportReplyEmail(facts: SupportReplyFacts): MailMessage {
  const link = supportThreadLink(facts.webPublicUrl, facts.organizationSlug, facts.threadId);
  const topic = oneLine(facts.subject);
  const subject = `TManage support replied: ${topic}`;
  const text = [
    'The TManage support team answered your conversation:',
    '',
    topic,
    '',
    `Read the reply in TManage: ${link}`,
    '',
    `You can also answer this e-mail; it reaches ${SUPPORT_REPLY_TO}.`,
  ].join('\n');
  return {
    to: oneLine(facts.to),
    subject,
    text,
    replyTo: SUPPORT_REPLY_TO,
    html: renderActionEmail({
      arabic: false,
      subject,
      eyebrow: 'TManage support',
      heading: 'You have a reply',
      intro: 'The TManage support team answered your conversation.',
      rows: [{ label: 'Subject', value: topic }],
      button: 'Read the reply',
      link,
      fallback: 'Button not working? Copy this link into your browser:',
      note: `You can also answer this e-mail; it reaches ${SUPPORT_REPLY_TO}.`,
      footer: 'You receive this because you wrote to TManage support.',
    }),
  };
}
