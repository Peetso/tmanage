import { LINK_TOKENS } from '@tmanage/mail';
import type { MailMessage } from '@tmanage/mail';

/**
 * LANE-Q — the outreach introduction, exactly the owner-approved text (EMAIL-DRAFT-v1, with the
 * owner's 2026-11-20 changes): plain text, written by one teammate, no boilerplate block.
 *
 * - Greeting with the person's first name (every imported row has one; no "Hi there").
 * - Signature "{name}\nTManage · tmanageapp.com". A US recipient also gets the postal address from
 *   CAMPAIGN_POSTAL_ADDRESS (CAN-SPAM); nobody else gets an address line (owner 2026-11-23).
 * - Owner 2026-11-23: the eight languages, the features coming in the next 1-2 months, and the
 *   3 free months after the beta.
 * - The unsubscribe is the personal last line; the sender resolver fills the link token with the
 *   signed one-click link and stamps the RFC 8058 List-Unsubscribe headers (ADR-0013).
 * - Replies go to the sender's own mailbox (the resolver's person identity).
 * - No tracking pixel, no HTML, two links: the personal trial link and the walkthrough page.
 */

export interface CampaignMailInput {
  readonly to: string;
  readonly language: 'en' | 'ar';
  readonly firstName: string;
  readonly company: string;
  /** The sender as the registry names them (first name; the registry holds no surname). */
  readonly senderName: string;
  readonly senderPersonId: string;
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
  readonly postalAddress: string;
  readonly trialUrl: string;
  readonly bookingUrl: string;
}

export const CAMPAIGN_SUBJECT = {
  en: 'Client approvals without the email chase',
  ar: 'موافقات العملاء دون ملاحقة عبر البريد',
} as const;

/**
 * The postal address, for US recipients only (CAN-SPAM, 15 U.S.C. §7704(a)(5)(A)(iii)); nobody else
 * gets an address line (owner 2026-11-23: no "Cairo, Egypt").
 */
function addressLines(input: CampaignMailInput): string[] {
  if (input.country === 'US' && input.postalAddress.trim() !== '')
    return [input.postalAddress.trim()];
  return [];
}

function englishText(input: CampaignMailInput): string {
  return [
    `Hi ${input.firstName},`,
    '',
    `I'm ${input.senderName} from TManage. We build a project and client-approval tool for agencies and studios like ${input.company}.`,
    '',
    'Most teams we talk to run projects in one tool, chat in another, and chase client sign-off by email. TManage puts it in one place:',
    '',
    '- Clients approve each version in their own portal. Every approval is tied to the exact file, with a certificate.',
    '- Tasks, timelines, workload and time tracking for the team.',
    '- Team chat that turns any message into a task or a recorded decision.',
    '- Invoices from tracked time.',
    '',
    '- Fully localized: English, Arabic, French, Spanish, German, Portuguese, Chinese and Urdu.',
    '',
    'Coming in the next 1-2 months:',
    '',
    '- AI employees you invite like teammates, who take on tasks and hand in the work.',
    '- A sales pipeline and contracts.',
    '- A help desk for client requests.',
    '- HR and purchasing.',
    '',
    "It's free while we're in beta, and your team keeps it free for 3 more months after the beta ends. Your workspace is ready here, with no card needed:",
    input.trialUrl,
    '',
    'If a 20-minute walkthrough would help, pick a time that suits you:',
    input.bookingUrl,
    '',
    'Best,',
    input.senderName,
    'TManage · tmanageapp.com',
    ...addressLines(input),
    '',
    `If this isn't relevant, just say so, or use this link and I won't write again: ${LINK_TOKENS.unsubscribe}`,
  ].join('\n');
}

function arabicText(input: CampaignMailInput): string {
  return [
    `مرحباً ${input.firstName}،`,
    '',
    `أنا ${input.senderName} من TManage. نحن نطوّر أداة لإدارة المشاريع وموافقات العملاء، مصممة للوكالات واستوديوهات التصميم وشركات البرمجة مثل ${input.company}.`,
    '',
    'معظم الفرق التي نتحدث معها تدير مشاريعها في أداة، وتتواصل في أداة أخرى، وتلاحق موافقة العميل عبر البريد. يجمع TManage ذلك كله في مكان واحد:',
    '',
    '- يعتمد العميل كل نسخة من بوابته الخاصة، وكل موافقة مرتبطة بالملف نفسه مع شهادة توثّقها.',
    '- مهام وجداول زمنية وتوزيع للعمل وتتبع للوقت لفريقك.',
    '- محادثات للفريق، يمكن تحويل أي رسالة فيها إلى مهمة أو قرار موثّق.',
    '- فواتير من الوقت المسجّل.',
    '- النظام مترجم بالكامل: العربية والإنجليزية والفرنسية والإسبانية والألمانية والبرتغالية والصينية والأردية.',
    '',
    'قريباً، خلال الشهر أو الشهرين القادمين:',
    '',
    '- موظفون بالذكاء الاصطناعي تدعونهم مثل أي عضو في الفريق، يستلمون المهام ويسلّمون العمل.',
    '- مسار للمبيعات والعقود.',
    '- مكتب دعم لطلبات العملاء.',
    '- الموارد البشرية والمشتريات.',
    '',
    'الاستخدام مجاني طوال الفترة التجريبية، ويبقى مجانياً لفريقكم 3 أشهر إضافية بعد انتهائها. مساحة عملكم جاهزة من هنا دون بطاقة دفع:',
    input.trialUrl,
    '',
    'وإذا رغبتم في جولة تعريفية مدتها 20 دقيقة مع أحد أعضاء فريقنا، اختاروا الموعد المناسب:',
    input.bookingUrl,
    '',
    'مع خالص التحية،',
    input.senderName,
    'TManage · tmanageapp.com',
    ...addressLines(input),
    '',
    `إن لم يكن هذا مناسباً لكم، يكفي الرد بذلك، أو من هذا الرابط ولن أراسلكم مجدداً: ${LINK_TOKENS.unsubscribe}`,
  ].join('\n');
}

/** One introduction, ready for the sender resolver (template `campaign_intro`, person mail). */
export function composeCampaignIntro(input: CampaignMailInput): MailMessage {
  return {
    to: input.to,
    subject: CAMPAIGN_SUBJECT[input.language],
    text: input.language === 'ar' ? arabicText(input) : englishText(input),
    templateKey: 'campaign_intro',
    language: input.language,
    personRef: { kind: 'campaign', personId: input.senderPersonId },
    optional: true,
  };
}

/** The two links, on the site in the recipient's language. Attribution rides in the URL only. */
export function campaignLinks(
  webPublicUrl: string,
  language: 'en' | 'ar',
  trialToken: string,
): { trialUrl: string; bookingUrl: string } {
  const base = webPublicUrl.replace(/\/+$/u, '');
  const prefix = language === 'ar' ? '/ar' : '';
  const trial = new URL(`${base}${prefix}/sign-up`);
  trial.searchParams.set('trial', trialToken);
  trial.searchParams.set('utm_source', 'campaign');
  trial.searchParams.set('utm_medium', 'email');
  trial.searchParams.set('utm_campaign', 'outreach-v1');
  const booking = new URL(`${base}${prefix}/walkthrough`);
  booking.searchParams.set('utm_source', 'campaign');
  return { trialUrl: trial.toString(), bookingUrl: booking.toString() };
}
