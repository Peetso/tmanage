import { anchored, plainMailText, signOff } from '@tmanage/mail';
import type { MailLanguage, MailMessage } from '@tmanage/mail';

/**
 * EMAIL-COPY S9: the one-time code a public link or a sign-up challenge asks for, signed [SEC].
 * The code is never in the subject (a preview pane shows the subject).
 */
export function composeCodeNotice(facts: {
  readonly to: string;
  readonly code: string;
  readonly minutes: number;
  readonly language: MailLanguage;
  readonly templateKey: 'public_link_code' | 'challenge_code';
}): MailMessage {
  const { language } = facts;
  const lines =
    language === 'ar'
      ? [
          `رمزك هو ${facts.code}.`,
          `أدخله في الصفحة التي طلبته. يعمل مرة واحدة وينتهي خلال ${facts.minutes} دقيقة.`,
          'لم تطلب هذا الرمز؟ تجاهل الرسالة؛ لا شيء يُفتح بدون الرمز.',
        ]
      : [
          `Your code is ${facts.code}.`,
          `Enter it on the page that asked for it. It works once and expires in ${facts.minutes} minutes.`,
          'Did not ask for it? Ignore this e-mail; nothing opens without the code.',
        ];
  return {
    to: facts.to,
    language,
    subject: anchored(language, language === 'ar' ? 'رمزك في TManage' : 'Your TManage code'),
    templateKey: facts.templateKey,
    text: plainMailText(language, { lines, signature: signOff('security', language) }),
  };
}
