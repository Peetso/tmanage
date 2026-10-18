import type { Mailer, MailMessage } from '@tmanage/mail';
import { serializeForLog } from '../observability/logger.js';
import { renderActionEmail } from './action-email.js';

/**
 * The welcome email a public sign-up sends (in the shared action-email layout).
 *
 * It carries no credential: the link is the new workspace's own address, which the person is
 * already signed in to. Verification of the address is not required to use the account yet
 * (Peter, 2026-10-18: "open the sign up for public for now"), so the message says welcome and
 * nothing more — it is also the first signal to a mailbox owner that somebody used their address.
 */

export interface WelcomeEmailFacts {
  readonly to: string;
  readonly displayName: string;
  readonly organizationName: string;
  /** Built by {@link WelcomeMailer} from configuration, never from a request header. */
  readonly link: string;
  readonly locale?: string;
}

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

export function composeWelcomeEmail(facts: WelcomeEmailFacts): MailMessage {
  const arabic = (facts.locale ?? 'en').toLowerCase().startsWith('ar');
  const name = oneLine(facts.displayName);
  const workspace = oneLine(facts.organizationName);

  const copy = arabic
    ? {
        subject: 'مرحبًا بك في TManage',
        eyebrow: 'حساب جديد',
        heading: `مرحبًا ${name}، مساحة عملك جاهزة`,
        intro: `أنشأت مساحة العمل «${workspace}» وأنت مالكها. افتحها لتبدأ.`,
        button: 'فتح مساحة العمل',
        fallback: 'إذا لم يعمل الزر، انسخ هذا الرابط والصقه في المتصفح:',
        note: 'لا يحتوي هذا الرابط على كلمة مرور ولا يمنح أي وصول بمفرده.',
        footer: 'إن لم تنشئ هذا الحساب فتجاهل هذه الرسالة أو اكتب إلى الدعم ليُحذف الحساب.',
      }
    : {
        subject: 'Welcome to TManage',
        eyebrow: 'New account',
        heading: `Hi ${name}, your workspace is ready`,
        intro: `You created the workspace "${workspace}" and you are its owner. Open it to get started.`,
        button: 'Open your workspace',
        fallback: 'Button not working? Copy this link into your browser:',
        note: 'This link carries no password and grants no access on its own.',
        footer:
          'If you did not create this account, ignore this email or write to support and we will remove it.',
      };

  return {
    to: facts.to,
    subject: copy.subject,
    text: [copy.heading, copy.intro, `${copy.button}: ${facts.link}`, copy.note, copy.footer].join(
      '\n\n',
    ),
    html: renderActionEmail({ arabic, link: facts.link, rows: [], ...copy }),
  };
}

/** Sends the welcome email; a mail failure is logged and never fails the sign-up. */
export class WelcomeMailer {
  constructor(
    private readonly mailer: Mailer | null,
    private readonly webPublicUrl: string,
  ) {}

  get enabled(): boolean {
    return this.mailer !== null;
  }

  async deliver(
    facts: Omit<WelcomeEmailFacts, 'link'> & { readonly organizationSlug: string },
  ): Promise<'sent' | 'none' | 'failed'> {
    if (this.mailer === null) return 'none';
    const { organizationSlug, ...rest } = facts;
    const link = `${this.webPublicUrl.replace(/\/+$/u, '')}/${encodeURIComponent(organizationSlug)}`;
    try {
      return await this.mailer.send(composeWelcomeEmail({ ...rest, link }));
    } catch (error) {
      console.error('[mailer] welcome email failed', serializeForLog(error));
      return 'failed';
    }
  }
}
