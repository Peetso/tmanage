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
  const when = facts.scheduledFor === undefined ? '' : formatMailDate(facts.scheduledFor, false);
  const open = facts.link === undefined ? [] : [`Open it here: ${facts.link}`];
  switch (kind) {
    case 'export_ready':
      return {
        subject: 'Your TManage data export is ready',
        lines: [
          company
            ? `The export of ${studio}'s data you asked for is ready to download.`
            : `The personal data export you asked for in ${studio} is ready to download.`,
          'The download link works for 7 days. After that the file is removed.',
          ...open,
        ],
      };
    case 'deletion_scheduled':
      return {
        subject: company
          ? `${studio} is scheduled to be deleted on ${when}`
          : `Your account in ${studio} is scheduled to be deleted on ${when}`,
        lines: [
          company
            ? `A request was made to delete ${studio} and all of its data. It will be carried out on ${when}. Until then, an owner can cancel it.`
            : `A request was made to delete your account in ${studio}. It will be carried out on ${when}. Until then, you can cancel it.`,
          ...open,
          'If you did not expect this, contact an owner of your company now.',
        ],
      };
    case 'deletion_cancelled':
      return {
        subject: company
          ? `The deletion of ${studio} was cancelled`
          : `The deletion of your account in ${studio} was cancelled`,
        lines: [
          company
            ? `${studio} will not be deleted. Everything stays as it was.`
            : `Your account in ${studio} will not be deleted. Everything stays as it was.`,
          ...open,
        ],
      };
    case 'deletion_executed':
      return {
        subject: company ? `${studio} was deleted` : `Your account in ${studio} was deleted`,
        lines: [
          company
            ? `As requested, ${studio} was closed and can no longer be opened. Its data and files are erased within the next day.`
            : `As requested, your access to ${studio} was removed. Work you shared with the team stays, shown as a former member.`,
        ],
      };
  }
}

function arabicCopy(kind: PrivacyMailKind, facts: PrivacyEmailFacts): Copy {
  const studio = oneLine(facts.organizationName);
  const company = facts.scope === 'company';
  const when = facts.scheduledFor === undefined ? '' : formatMailDate(facts.scheduledFor, true);
  const open = facts.link === undefined ? [] : [`افتحه من هنا: ${facts.link}`];
  switch (kind) {
    case 'export_ready':
      return {
        subject: 'نسخة بياناتك من TManage جاهزة',
        lines: [
          company
            ? `نسخة بيانات ${studio} التي طلبتها جاهزة للتنزيل.`
            : `نسخة بياناتك الشخصية في ${studio} التي طلبتها جاهزة للتنزيل.`,
          'رابط التنزيل صالح لمدة 7 أيام، وبعدها يُحذف الملف.',
          ...open,
        ],
      };
    case 'deletion_scheduled':
      return {
        subject: company ? `سيُحذف ${studio} في ${when}` : `سيُحذف حسابك في ${studio} في ${when}`,
        lines: [
          company
            ? `طُلب حذف ${studio} وكل بياناته. سيتم الحذف في ${when}، ويمكن لأي مالك إلغاؤه قبل ذلك.`
            : `طُلب حذف حسابك في ${studio}. سيتم الحذف في ${when}، ويمكنك إلغاؤه قبل ذلك.`,
          ...open,
          'إذا لم تكن تتوقع هذا، فتواصل الآن مع أحد مالكي شركتك.',
        ],
      };
    case 'deletion_cancelled':
      return {
        subject: company ? `أُلغي حذف ${studio}` : `أُلغي حذف حسابك في ${studio}`,
        lines: [
          company
            ? `لن يُحذف ${studio}، وكل شيء باقٍ كما كان.`
            : `لن يُحذف حسابك في ${studio}، وكل شيء باقٍ كما كان.`,
          ...open,
        ],
      };
    case 'deletion_executed':
      return {
        subject: company ? `حُذف ${studio}` : `حُذف حسابك في ${studio}`,
        lines: [
          company
            ? `بناءً على الطلب، أُغلق ${studio} ولم يعد بالإمكان فتحه. تُمحى بياناته وملفاته خلال اليوم التالي.`
            : `بناءً على الطلب، أُزيل وصولك إلى ${studio}. يبقى العمل الذي شاركته مع الفريق ظاهرًا باسم عضو سابق.`,
        ],
      };
  }
}

export function composePrivacyEmail(kind: PrivacyMailKind, facts: PrivacyEmailFacts): MailMessage {
  const name = oneLine(facts.recipientName);
  const studio = oneLine(facts.organizationName);
  if (isArabicLocale(facts.locale)) {
    const copy = arabicCopy(kind, facts);
    return {
      to: facts.recipientEmail,
      subject: copy.subject,
      text: [
        `مرحبًا ${name}،`,
        ...copy.lines,
        `تصلك هذه الرسالة لأنها تخص بياناتك في ${studio} على TManage.`,
      ]
        .map((line) => `${RLM}${line}`)
        .join('\n\n'),
    };
  }
  const copy = englishCopy(kind, facts);
  return {
    to: facts.recipientEmail,
    subject: copy.subject,
    text: [
      `Hello ${name},`,
      ...copy.lines,
      `You are receiving this because it concerns your data in ${studio} on TManage.`,
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
      return await this.mailer.send(composePrivacyEmail(kind, facts));
    } catch (error) {
      // Absorbed loudly, without the address: the driver's words may name the recipient.
      console.error(`[worker] privacy ${kind} email failed`, error);
      return 'failed';
    }
  }
}
