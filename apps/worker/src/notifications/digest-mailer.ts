import { LINK_TOKENS, forCompany, greeting, signOff } from '@tmanage/mail';
import type { Mailer, MailMessage } from '@tmanage/mail';
import type { NaturalNotificationKind } from '@tmanage/domain';
import { briefingSectionParagraphs } from './briefing-mail.js';
import type { DigestBriefingSection } from './briefing-mail.js';
import { isArabicLocale } from './collaboration-mailer.js';

/**
 * 53-15 — the notification digest e-mail: one summary instead of twenty. It names how many updates
 * of each kind are waiting and links to the inbox; it never quotes a title, a message or a comment
 * (those can be edited or withdrawn after the mail leaves, and the inbox re-checks access on open).
 * English, or Arabic for an `ar*` locale.
 *
 * 62-A1c: a person who switched it on also gets the business briefing as one section (the Home
 * card's lines, `briefing-mail.ts`). The mail goes out when either part has something to say:
 * counts only, the briefing only, or both; never empty (the store does not claim an empty one).
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
  /** 62-A1c: the business briefing section; absent when switched off, flag off or nothing open. */
  readonly briefing?: DigestBriefingSection;
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

/** U+200F, the right-to-left mark: keeps a mixed Arabic/Latin line anchored right. */
const RLM = String.fromCodePoint(0x20_0f);

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

/** The total of all counts. */
export function digestTotal(counts: DigestEmailFacts['counts']): number {
  return KIND_ORDER.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
}

/** EMAIL-COPY N14, signed [TM]; its settings link is the real notification-settings screen. */
export function composeDigestEmail(facts: DigestEmailFacts): MailMessage {
  const total = digestTotal(facts.counts);
  const studio = oneLine(facts.organizationName);
  const kinds = KIND_ORDER.filter((kind) => (facts.counts[kind] ?? 0) > 0);
  const arabic = isArabicLocale(facts.locale);
  const language = arabic ? 'ar' : 'en';
  const signature = signOff('notice', language)
    .map((line) => line.replace(LINK_TOKENS.settings, facts.settingsLink))
    .join('\n');
  const briefing =
    facts.briefing === undefined ? [] : briefingSectionParagraphs(facts.briefing, language);
  if (arabic) {
    const period = facts.cadence === 'weekly' ? 'الأسبوعي' : 'اليومي';
    const phrase = facts.cadence === 'weekly' ? 'هذا الأسبوع' : 'منذ أمس';
    const updates =
      kinds.length === 0
        ? []
        : [
            `${RLM}هذا ما حدث في ${studio} ${phrase}:`,
            kinds.map((kind) => `• ${AR_KIND[kind]}: ${String(facts.counts[kind])}`).join('\n'),
          ];
    return {
      to: facts.recipientEmail,
      language,
      subject:
        total > 0
          ? `${RLM}ملخصك ${period} في ${studio}: ${String(total)} تحديثات`
          : `${RLM}موجز العمل في ${studio}`,
      text: [
        greeting(language, facts.recipientName),
        ...updates,
        ...briefing,
        `${RLM}افتح TManage: ${facts.inboxLink}`,
        'تريد الملخص بوتيرة أقل أو لا تريده؟ غيّر ذلك من إعدادات الإشعارات بالأسفل.',
        signature,
      ].join('\n\n'),
    };
  }
  const period = facts.cadence === 'weekly' ? 'weekly' : 'daily';
  const phrase = facts.cadence === 'weekly' ? 'this week' : 'since yesterday';
  const updates =
    kinds.length === 0
      ? []
      : [
          `Here is what happened in ${studio} ${phrase}:`,
          kinds.map((kind) => `• ${EN_KIND[kind]}: ${String(facts.counts[kind])}`).join('\n'),
        ];
  return {
    to: facts.recipientEmail,
    language,
    subject:
      total > 0
        ? `Your ${period} summary for ${studio}: ${String(total)} update${total === 1 ? '' : 's'}`
        : `Your business briefing for ${studio}`,
    text: [
      greeting(language, facts.recipientName),
      ...updates,
      ...briefing,
      `Open TManage: ${facts.inboxLink}`,
      'Want this less often, or not at all? Change it in Notification settings below.',
      signature,
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
