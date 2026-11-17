import { forCompany, greeting, signOffText } from '@tmanage/mail';
import type { Mailer, MailMessage } from '@tmanage/mail';
import { isArabicLocale } from './collaboration-mailer.js';

/**
 * H3 (NFR-09, 33-LEGAL §8 "… → respond") — the data-rights emails, on the same `@tmanage/mail` port
 * and in the same shape as the other relay mailers: composed from facts re-read at delivery, sent
 * after the batch commits, and `deliver` never throws.
 *
 * Two events produce them:
 *
 * - `privacy_export.ready.v1` → "your data export is ready", to the person who asked for it, with a
 *   link to the screen it is downloaded from (the seven-day link is the screen's, never a raw file).
 * - `privacy_deletion.changed.v1` → "scheduled for <date>" / "cancelled" / "carried out", for a
 *   company deletion to its owners and to whoever asked, for an account deletion to that person.
 *
 * English, or Arabic for an `ar*` locale (each Arabic line opens with U+200F so a line that carries
 * a Latin studio name or link stays anchored right). The copy names the studio, the kind and the
 * date; it never carries file contents, ids or anything a person wrote.
 */

export type PrivacyMailKind =
  'export_ready' | 'deletion_scheduled' | 'deletion_cancelled' | 'deletion_executed';

export interface PrivacyEmailFacts {
  /** 56-26: the sending company — its Message-ID is signed and its bounce suppressions apply. */
  readonly organizationId?: string;
  readonly recipientEmail: string;
  readonly recipientName: string;
  readonly locale: string;
  readonly organizationName: string;
  /** `company` or `account` for a deletion; `company` or `member` for an export. */
  readonly scope: 'company' | 'account' | 'member';
  /** The end of the grace period — `deletion_scheduled` only. */
  readonly scheduledFor?: Date;
  /** The screen to act from; absent once the company is closed or the account removed. */
  readonly link?: string;
}

const RLM = '‏';

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

/** A calendar date in the reader's language, UTC (the grace period ends at that instant). */
export function formatMailDate(date: Date, arabic: boolean): string {
  return new Intl.DateTimeFormat(arabic ? 'ar' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

interface Copy {
  readonly subject: string;
  readonly lines: readonly string[];
}

function englishCopy(kind: PrivacyMailKind, facts: PrivacyEmailFacts): Copy {
  const studio = oneLine(facts.organizationName);
  const company = facts.scope === 'company';
  const subject = company ? studio : `your account in ${studio}`;
  const Subject = company ? studio : `Your account in ${studio}`;
  const when = facts.scheduledFor === undefined ? '' : formatMailDate(facts.scheduledFor, false);
  const link = (label: string): string[] =>
    facts.link === undefined ? [] : [`${label}: ${facts.link}`];
  switch (kind) {
    case 'export_ready':
      return {
        subject: 'Your TManage data export is ready',
        lines: [
          company
            ? `The copy of the data of ${studio} that you asked for is ready.`
            : 'The copy of your data that you asked for is ready.',
          ...link('Download it'),
          'The file stays available for 7 days. You need to be signed in to download it.',
        ],
      };
    case 'deletion_scheduled':
      return {
        subject: `${Subject} will be deleted on ${when}`,
        lines: [
          `${Subject} is scheduled to be deleted on ${when}. Until then nothing is removed.`,
          ...link('Cancel the deletion'),
        ],
      };
    case 'deletion_cancelled':
      return {
        subject: `The deletion of ${subject} was cancelled`,
        lines: [
          company
            ? `The deletion was cancelled. ${studio} and its data stay as they were.`
            : 'The deletion was cancelled. Your account and its data stay as they were.',
          ...link('Open TManage'),
        ],
      };
    case 'deletion_executed':
      return {
        subject: `${Subject} was deleted`,
        lines: [
          company
            ? `${studio} and its data were deleted, as requested. This is the last e-mail we send about it.`
            : `Your account in ${studio} and its personal data were deleted, as requested. This is the last e-mail we send about it.`,
        ],
      };
  }
}

function arabicCopy(kind: PrivacyMailKind, facts: PrivacyEmailFacts): Copy {
  const studio = oneLine(facts.organizationName);
  const company = facts.scope === 'company';
  const target = company ? studio : `حسابك في ${studio}`;
  const when = facts.scheduledFor === undefined ? '' : formatMailDate(facts.scheduledFor, true);
  const link = (label: string): string[] =>
    facts.link === undefined ? [] : [`${label}: ${facts.link}`];
  switch (kind) {
    case 'export_ready':
      return {
        subject: 'نسخة بياناتك من TManage جاهزة',
        lines: [
          company
            ? `نسخة بيانات ${studio} التي طلبتها أصبحت جاهزة.`
            : 'نسخة بياناتك التي طلبتها أصبحت جاهزة.',
          ...link('نزّل النسخة'),
          'يبقى الملف متاحًا لمدة 7 أيام، ويلزم تسجيل الدخول لتنزيله.',
        ],
      };
    case 'deletion_scheduled':
      return {
        subject: `سيُحذف ${target} يوم ${when}`,
        lines: [
          `${target} مجدول للحذف يوم ${when}. حتى ذلك اليوم لن يُحذف أي شيء.`,
          ...link('إلغاء الحذف'),
        ],
      };
    case 'deletion_cancelled':
      return {
        subject: `أُلغي حذف ${target}`,
        lines: [
          company
            ? `أُلغي الحذف. ${studio} وبياناتها باقية كما كانت.`
            : 'أُلغي الحذف. حسابك وبياناته باقية كما كانت.',
          ...link('افتح TManage'),
        ],
      };
    case 'deletion_executed':
      return {
        subject: `حُذف ${target}`,
        lines: [
          company
            ? `حُذفت ${studio} وبياناتها كما طلبت. هذه آخر رسالة نرسلها بخصوصها.`
            : `حُذف حسابك في ${studio} وبياناته الشخصية كما طلبت. هذه آخر رسالة نرسلها بخصوصه.`,
        ],
      };
  }
}

/** EMAIL-COPY S11, signed [SEC]. */
export function composePrivacyEmail(kind: PrivacyMailKind, facts: PrivacyEmailFacts): MailMessage {
  const arabic = isArabicLocale(facts.locale);
  const language = arabic ? 'ar' : 'en';
  const copy = arabic ? arabicCopy(kind, facts) : englishCopy(kind, facts);
  const mark = arabic ? RLM : '';
  const help = arabic
    ? 'لم تطلب ذلك؟ راسلنا على support@tmanageapp.com.'
    : 'Did not ask for this? Write to support@tmanageapp.com.';
  return {
    to: facts.recipientEmail,
    language,
    subject: `${mark}${copy.subject}`,
    text: [
      `${mark}${greeting(language, facts.recipientName)}`,
      ...[...copy.lines, help].map((line) => `${mark}${line}`),
      signOffText('security', language),
    ].join('\n\n'),
  };
}

export type PrivacyMailDelivery = 'sent' | 'none' | 'failed';

export class PrivacyMailer {
  /**
   * @param mailer `null` when no transport is wired.
   * @param webPublicUrl `WEB_PUBLIC_URL`, the origin links are built from.
   */
  constructor(
    private readonly mailer: Mailer | null,
    private readonly webPublicUrl: string,
  ) {}

  get enabled(): boolean {
    return this.mailer !== null;
  }

  /** An absolute link to a path in the web app. */
  linkTo(path: string): string {
    const origin = this.webPublicUrl.replace(/\/+$/u, '');
    return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
  }

  compose(kind: PrivacyMailKind, facts: PrivacyEmailFacts): MailMessage {
    return composePrivacyEmail(kind, facts);
  }

  async deliver(kind: PrivacyMailKind, facts: PrivacyEmailFacts): Promise<PrivacyMailDelivery> {
    if (this.mailer === null) return 'none';
    try {
      return await this.mailer.send(
        forCompany(composePrivacyEmail(kind, facts), facts.organizationId),
      );
    } catch (error) {
      // Absorbed loudly, without the address: the driver's words may name the recipient.
      console.error(`[worker] privacy ${kind} email failed`, error);
      return 'failed';
    }
  }
}
