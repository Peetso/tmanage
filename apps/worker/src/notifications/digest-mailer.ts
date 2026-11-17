import { forCompany } from '@tmanage/mail';
import type { Mailer, MailMessage } from '@tmanage/mail';
import type { NaturalNotificationKind } from '@tmanage/domain';
import { isArabicLocale } from './collaboration-mailer.js';

/**
 * 53-15 — the notification digest e-mail: one summary instead of twenty. It names how many updates
 * of each kind are waiting and links to the inbox; it never quotes a title, a message or a comment
 * (those can be edited or withdrawn after the mail leaves, and the inbox re-checks access on open).
 * English, or Arabic for an `ar*` locale.
 */

export interface DigestEmailFacts {
  /** 56-26: the sending company — its Message-ID is signed and its bounce suppressions apply. */
  readonly organizationId?: string;
  readonly recipientEmail: string;
  readonly recipientName: string;
  readonly organizationName: string;
  readonly locale?: string;
  readonly cadence: 'daily' | 'weekly';
  /** Unread updates per kind, only kinds with at least one. */
  readonly counts: Readonly<Partial<Record<NaturalNotificationKind, number>>>;
  /** Absolute links: the inbox, and the notification settings. */
  readonly inboxLink: string;
  readonly settingsLink: string;
}

const KIND_ORDER: readonly NaturalNotificationKind[] = [
  'mention',
  'client_request',
  'work_item',
  'file',
  'message',
];

const EN_KIND: Readonly<Record<NaturalNotificationKind, string>> = {
  mention: 'Mentions',
  client_request: 'Client requests and approvals',
  work_item: 'Work, deadlines and schedule',
  file: 'Files and reviews',
  message: 'Messages and comments',
};

const AR_KIND: Readonly<Record<NaturalNotificationKind, string>> = {
  mention: 'الإشارات',
  client_request: 'طلبات العملاء والموافقات',
  work_item: 'المهام والمواعيد والجدول',
  file: 'الملفات والمراجعات',
  message: 'الرسائل والتعليقات',
};

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

/** The total of all counts. */
export function digestTotal(counts: DigestEmailFacts['counts']): number {
  return KIND_ORDER.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
}

export function composeDigestEmail(facts: DigestEmailFacts): MailMessage {
  const total = digestTotal(facts.counts);
  const name = oneLine(facts.recipientName);
  const studio = oneLine(facts.organizationName);
  const kinds = KIND_ORDER.filter((kind) => (facts.counts[kind] ?? 0) > 0);
  if (isArabicLocale(facts.locale)) {
    const period = facts.cadence === 'weekly' ? 'الأسبوعي' : 'اليومي';
    return {
      to: facts.recipientEmail,
      subject: `ملخصك ${period} في ${studio}: ${String(total)} تحديثات`,
      text: [
        `مرحبًا ${name}،`,
        `لديك ${String(total)} تحديثات لم تقرأها بعد في ${studio}:`,
        kinds.map((kind) => `• ${AR_KIND[kind]}: ${String(facts.counts[kind])}`).join('\n'),
        `افتح صندوق الوارد: ${facts.inboxLink}`,
        `تصلك هذه الرسالة لأنك اخترت الملخص في إعدادات الإشعارات. غيّرها من هنا: ${facts.settingsLink}`,
      ].join('\n\n'),
    };
  }
  const period = facts.cadence === 'weekly' ? 'weekly' : 'daily';
  return {
    to: facts.recipientEmail,
    subject: `Your ${period} summary for ${studio}: ${String(total)} update${total === 1 ? '' : 's'}`,
    text: [
      `Hi ${name},`,
      `You have ${String(total)} unread update${total === 1 ? '' : 's'} in ${studio}:`,
      kinds.map((kind) => `• ${EN_KIND[kind]}: ${String(facts.counts[kind])}`).join('\n'),
      `Open your inbox: ${facts.inboxLink}`,
      `You get this because the summary is on in your notification settings. Change it here: ${facts.settingsLink}`,
    ].join('\n\n'),
  };
}

export type DigestMailDelivery = 'sent' | 'none' | 'failed';

/** The relay mailer shape: `deliver` never throws, it runs after commit. */
export class DigestMailer {
  /** @param mailer `null` when no transport is wired. */
  constructor(
    private readonly mailer: Mailer | null,
    private readonly webBaseUrl: string,
  ) {}

  get enabled(): boolean {
    return this.mailer !== null;
  }

  linkTo(path: string): string {
    return `${this.webBaseUrl.replace(/\/+$/u, '')}${path}`;
  }

  async deliver(facts: DigestEmailFacts): Promise<DigestMailDelivery> {
    if (this.mailer === null) return 'none';
    try {
      return await this.mailer.send(forCompany(composeDigestEmail(facts), facts.organizationId));
    } catch (error) {
      console.error('[worker] notification digest email failed', error);
      return 'failed';
    }
  }
}
