import { greeting } from '@tmanage/mail';
import type { MailMessage } from '@tmanage/mail';
import { renderActionEmail } from '../../common/email/action-email.js';
import { SUPPORT_REPLY_TO } from './support.policy.js';

/**
 * 55-17 — the e-mail a person receives when the TManage team answers their support conversation.
 * It names the subject and carries one link back into the app (the panel opens on the thread);
 * the reply text itself stays in the app. Replies to the mail go to {@link SUPPORT_REPLY_TO}.
 *
 * EMAILBUILD (c): EMAIL-COPY C1. A reply to the mail reaches the support inbox, not the thread, so
 * the mail says "it reaches our support team" (the copy's own note) and never "the same
 * conversation". The thread carries no language, so the mail is English.
 */

export interface SupportReplyFacts {
  readonly to: string;
  readonly subject: string;
  readonly organizationSlug: string;
  readonly threadId: string;
  readonly webPublicUrl: string;
  /** The staff member who answered, from the signed-in account; never typed in a form. */
  readonly agentName?: string;
  /** The person who opened the conversation. */
  readonly recipientName?: string | null;
}

export function supportThreadLink(webPublicUrl: string, slug: string, threadId: string): string {
  const base = webPublicUrl.replace(/\/+$/u, '');
  return `${base}/${encodeURIComponent(slug)}/help?request=${encodeURIComponent(threadId)}`;
}

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

export function buildSupportReplyEmail(facts: SupportReplyFacts): MailMessage {
  const link = supportThreadLink(facts.webPublicUrl, facts.organizationSlug, facts.threadId);
  const topic = oneLine(facts.subject);
  const agent = oneLine(facts.agentName ?? '');
  const subject = `Re: ${topic}`;
  const hello = greeting('en', facts.recipientName ?? undefined);
  const lead =
    agent === ''
      ? `Our support team answered your question "${topic}".`
      : `${agent} answered your question "${topic}".`;
  const replyHere =
    'You can also answer right here: reply to this e-mail and it reaches our support team.';
  const signature = [agent === '' ? 'TManage Support' : `${agent}, TManage Support`];
  const text = [hello, lead, `Read the answer: ${link}`, replyHere, signature.join('\n')].join(
    '\n\n',
  );
  return {
    to: oneLine(facts.to),
    language: 'en',
    subject,
    text,
    replyTo: SUPPORT_REPLY_TO,
    html: renderActionEmail({
      arabic: false,
      subject,
      preheader:
        agent === ''
          ? 'TManage support answered you.'
          : `${agent} from TManage support answered you.`,
      eyebrow: 'TManage support',
      heading: hello,
      intro: lead,
      rows: [],
      button: 'Read the answer',
      link,
      fallback: 'Button not working? Copy this link into your browser:',
      note: replyHere,
      footer: '',
      signature,
    }),
  };
}
