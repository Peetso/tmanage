import { anchored, designedPlainMail, mailEyebrow, signOff } from '@tmanage/mail';
import type { MailLanguage, MailMessage } from '@tmanage/mail';
import { arabicMinutes } from './arabic-minutes.js';

/**
 * EMAIL-COPY S9: the one-time code a public link or a sign-up challenge asks for, signed [SEC].
 * The code is never in the subject (a preview pane shows the subject). MAILDESIGN: drawn in the
 * shared layout, the code large in its own panel; the text part is unchanged.
 */
export function composeCodeNotice(facts: {
  readonly to: string;
  readonly code: string;
  readonly minutes: number;
  readonly language: MailLanguage;
  readonly templateKey: 'public_link_code' | 'challenge_code';
}): MailMessage {
  const { language } = facts;
  const codeLine = {
    code: facts.code,
    text: language === 'ar' ? `رمزك هو ${facts.code}.` : `Your code is ${facts.code}.`,
  };
  const lines =
    language === 'ar'
      ? [
          codeLine,
          `أدخله في الصفحة التي طلبته. يعمل مرة واحدة وينتهي خلال ${arabicMinutes(facts.minutes)}.`,
          'لم تطلب هذا الرمز؟ تجاهل الرسالة؛ لا شيء يُفتح بدون الرمز.',
        ]
      : [
          codeLine,
          `Enter it on the page that asked for it. It works once and expires in ${facts.minutes} minutes.`,
          'Did not ask for it? Ignore this e-mail; nothing opens without the code.',
        ];
  const subject = anchored(language, language === 'ar' ? 'رمزك في TManage' : 'Your TManage code');
  return {
    to: facts.to,
    language,
    subject,
    templateKey: facts.templateKey,
    ...designedPlainMail(language, {
      subject,
      eyebrow: mailEyebrow('security', language),
      lines,
      signature: signOff('security', language),
    }),
  };
}
