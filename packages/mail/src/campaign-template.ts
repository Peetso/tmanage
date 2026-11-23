import { LINK_TOKENS } from './sign-off.js';

/**
 * OUTREACH MANAGER (owner 2026-11-23) — the editable outreach e-mail, as pure functions shared by
 * the API (preview, test send, validation on save) and the worker (the real send). One function
 * renders both, so the preview is the mail (IP-2: one rule, one place).
 *
 * The platform admin edits a subject and a plain-text body per language. Two parts are not
 * editable and are added by {@link renderCampaignEmail} to every mail, whatever the text says:
 *
 * - the postal address, for a US recipient only (CAN-SPAM, 15 U.S.C. §7704(a)(5)(A)(iii));
 * - the personal unsubscribe line as the last line, carrying {@link LINK_TOKENS.unsubscribe},
 *   which the sender resolver fills with the signed one-click link while it stamps the RFC 8058
 *   `List-Unsubscribe` / `List-Unsubscribe-Post` headers (ADR-0013). A body may not carry the
 *   token itself, so the line can be neither removed nor doubled.
 *
 * Plain text only: an HTML tag is refused at save, and the mail is sent as `text/plain`, so there
 * is no tracking pixel and no hidden link. Placeholders are a closed list; an unknown `{…}` is
 * refused so a typo never reaches a recipient. Values are substituted in one pass, so a company
 * named "{trial link}" stays literal text.
 */

/** The site languages a campaign may write in (the eight message catalogs). */
export const CAMPAIGN_LANGUAGES = ['en', 'ar', 'fr', 'es', 'de', 'pt-BR', 'zh-CN', 'ur'] as const;
export type CampaignLanguage = (typeof CAMPAIGN_LANGUAGES)[number];

export function isCampaignLanguage(value: unknown): value is CampaignLanguage {
  return typeof value === 'string' && (CAMPAIGN_LANGUAGES as readonly string[]).includes(value);
}

export const CAMPAIGN_EMAIL_KINDS = ['intro', 'followup'] as const;
export type CampaignEmailKind = (typeof CAMPAIGN_EMAIL_KINDS)[number];

/** The placeholders, as written in the text, and the value each one takes. */
export const CAMPAIGN_PLACEHOLDERS = {
  '{first name}': 'firstName',
  '{company}': 'company',
  '{sender name}': 'senderName',
  '{trial link}': 'trialUrl',
  '{walkthrough link}': 'bookingUrl',
} as const;
export type CampaignPlaceholder = keyof typeof CAMPAIGN_PLACEHOLDERS;

/** A subject may name the person, the company and the sender, never a link. */
const SUBJECT_PLACEHOLDERS: ReadonlySet<string> = new Set([
  '{first name}',
  '{company}',
  '{sender name}',
]);

export const CAMPAIGN_SUBJECT_MAX = 150;
export const CAMPAIGN_BODY_MAX = 10_000;

export interface CampaignEmailText {
  readonly subject: string;
  readonly body: string;
}

/**
 * The fixed last line per language. EN and AR are the owner-approved wording (EMAIL-DRAFT-v1);
 * the others say the same in the same register.
 */
export const CAMPAIGN_UNSUBSCRIBE_LINES: Readonly<Record<CampaignLanguage, string>> = {
  en: `If this isn't relevant, just say so, or use this link and I won't write again: ${LINK_TOKENS.unsubscribe}`,
  ar: `إن لم يكن هذا مناسباً لكم، يكفي الرد بذلك، أو من هذا الرابط ولن أراسلكم مجدداً: ${LINK_TOKENS.unsubscribe}`,
  fr: `Si ce n'est pas pertinent, dites-le simplement, ou utilisez ce lien et je ne vous écrirai plus : ${LINK_TOKENS.unsubscribe}`,
  es: `Si no le interesa, basta con decírmelo, o use este enlace y no volveré a escribirle: ${LINK_TOKENS.unsubscribe}`,
  de: `Falls das nicht passt, sagen Sie es einfach, oder nutzen Sie diesen Link, und ich schreibe nicht wieder: ${LINK_TOKENS.unsubscribe}`,
  'pt-BR': `Se não fizer sentido, é só dizer, ou use este link e não escrevo mais: ${LINK_TOKENS.unsubscribe}`,
  'zh-CN': `如果与您无关，直接告诉我即可，或使用此链接，我将不再来信：${LINK_TOKENS.unsubscribe}`,
  ur: `اگر یہ آپ کے کام کا نہیں تو بس بتا دیں، یا یہ لنک استعمال کریں اور میں دوبارہ نہیں لکھوں گا: ${LINK_TOKENS.unsubscribe}`,
};

const INTRO_EN = [
  'Hi {first name},',
  '',
  "I'm {sender name} from TManage. We build a project and client-approval tool for agencies and studios like {company}.",
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
  '{trial link}',
  '',
  'If a 20-minute walkthrough would help, pick a time that suits you:',
  '{walkthrough link}',
  '',
  'Best,',
  '{sender name}',
  'TManage · tmanageapp.com',
].join('\n');

const INTRO_AR = [
  'مرحباً {first name}،',
  '',
  'أنا {sender name} من TManage. نحن نطوّر أداة لإدارة المشاريع وموافقات العملاء، مصممة للوكالات واستوديوهات التصميم وشركات البرمجة مثل {company}.',
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
  '{trial link}',
  '',
  'وإذا رغبتم في جولة تعريفية مدتها 20 دقيقة مع أحد أعضاء فريقنا، اختاروا الموعد المناسب:',
  '{walkthrough link}',
  '',
  'مع خالص التحية،',
  '{sender name}',
  'TManage · tmanageapp.com',
].join('\n');

const FOLLOWUP_EN = [
  'Hi {first name},',
  '',
  'A short follow-up to my note about TManage. If chasing client sign-off by email still slows {company} down, your workspace is ready here, with no card needed:',
  '{trial link}',
  '',
  'Or pick a time for a 20-minute walkthrough:',
  '{walkthrough link}',
  '',
  'Best,',
  '{sender name}',
  'TManage · tmanageapp.com',
].join('\n');

const FOLLOWUP_AR = [
  'مرحباً {first name}،',
  '',
  'متابعة قصيرة لرسالتي عن TManage. إن كانت ملاحقة موافقة العميل عبر البريد ما زالت تؤخّر {company}، فمساحة عملكم جاهزة من هنا دون بطاقة دفع:',
  '{trial link}',
  '',
  'أو اختاروا موعداً لجولة تعريفية مدتها 20 دقيقة:',
  '{walkthrough link}',
  '',
  'مع خالص التحية،',
  '{sender name}',
  'TManage · tmanageapp.com',
].join('\n');

/**
 * The default text of a new campaign, and version 1 of every campaign that existed before the
 * editor (migration 0409 seeds the same text; `outreach-manager.test.ts` keeps the two equal).
 */
export const DEFAULT_CAMPAIGN_EMAILS: Readonly<
  Record<CampaignEmailKind, Readonly<Partial<Record<CampaignLanguage, CampaignEmailText>>>>
> = {
  intro: {
    en: { subject: 'Client approvals without the email chase', body: INTRO_EN },
    ar: { subject: 'موافقات العملاء دون ملاحقة عبر البريد', body: INTRO_AR },
  },
  followup: {
    en: { subject: 'Following up: client approvals at {company}', body: FOLLOWUP_EN },
    ar: { subject: 'متابعة: موافقات العملاء في {company}', body: FOLLOWUP_AR },
  },
};

export type CampaignTextProblem =
  | 'subject_empty'
  | 'subject_too_long'
  | 'subject_line_break'
  | 'subject_placeholder'
  | 'body_empty'
  | 'body_too_long'
  | 'unknown_placeholder'
  | 'html_not_allowed'
  | 'reserved_token'
  | 'control_character';

const PLACEHOLDER_SHAPE = /\{[^{}\n]{1,40}\}/gu;
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(\s[^<>]*)?\/?>/iu;
// Tab and line feed are allowed in the body; carriage returns are normalised away first.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/u;
const RESERVED = /\[\[tm\.[a-z.]+\]\]/u;

/** Line endings to LF and trailing spaces off each line, so a pasted text compares cleanly. */
export function normaliseCampaignText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .trim();
}

/** Every problem with one language's text; empty when it may be saved. */
export function campaignTextProblems(text: CampaignEmailText): CampaignTextProblem[] {
  const problems = new Set<CampaignTextProblem>();
  const subject = text.subject.trim();
  const body = normaliseCampaignText(text.body);
  if (subject === '') problems.add('subject_empty');
  if (subject.length > CAMPAIGN_SUBJECT_MAX) problems.add('subject_too_long');
  if (/[\r\n]/u.test(text.subject)) problems.add('subject_line_break');
  if (body === '') problems.add('body_empty');
  if (body.length > CAMPAIGN_BODY_MAX) problems.add('body_too_long');
  for (const match of subject.matchAll(PLACEHOLDER_SHAPE)) {
    if (!SUBJECT_PLACEHOLDERS.has(match[0])) problems.add('subject_placeholder');
  }
  for (const match of body.matchAll(PLACEHOLDER_SHAPE)) {
    if (!Object.prototype.hasOwnProperty.call(CAMPAIGN_PLACEHOLDERS, match[0])) {
      problems.add('unknown_placeholder');
    }
  }
  if (HTML_TAG.test(subject) || HTML_TAG.test(body)) problems.add('html_not_allowed');
  if (RESERVED.test(subject) || RESERVED.test(body)) problems.add('reserved_token');
  if (CONTROL.test(subject) || CONTROL.test(body)) problems.add('control_character');
  return [...problems];
}

export interface CampaignRenderValues {
  readonly firstName: string;
  readonly company: string;
  readonly senderName: string;
  readonly trialUrl: string;
  readonly bookingUrl: string;
}

export interface CampaignRenderInput {
  readonly text: CampaignEmailText;
  readonly language: CampaignLanguage;
  readonly values: CampaignRenderValues;
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
  /** CAMPAIGN_POSTAL_ADDRESS ('' = unset; a US recipient is then never sent to). */
  readonly postalAddress: string;
}

/** A substituted value can never inject a reserved token or a line break into the subject. */
function clean(value: string): string {
  return value.replace(/\[\[/gu, '[ [').replace(/[\r\n]+/gu, ' ');
}

function substitute(template: string, values: CampaignRenderValues): string {
  return template.replace(PLACEHOLDER_SHAPE, (token) => {
    const key = (CAMPAIGN_PLACEHOLDERS as Readonly<Record<string, keyof CampaignRenderValues>>)[
      token
    ];
    return key === undefined ? token : clean(values[key]);
  });
}

/**
 * The mail exactly as it leaves: the edited text with its placeholders filled, then the US postal
 * address (US only), then a blank line and the fixed unsubscribe line.
 */
export function renderCampaignEmail(input: CampaignRenderInput): {
  readonly subject: string;
  readonly text: string;
} {
  const body = substitute(normaliseCampaignText(input.text.body), input.values);
  const address =
    input.country === 'US' && input.postalAddress.trim() !== '' ? [input.postalAddress.trim()] : [];
  return {
    subject: substitute(input.text.subject.trim(), input.values).slice(0, 200),
    text: [body, ...address, '', CAMPAIGN_UNSUBSCRIBE_LINES[input.language]].join('\n'),
  };
}

/** The resolver's language for a campaign language (names, footers): Arabic or English. */
export function campaignMailLanguage(language: CampaignLanguage): 'en' | 'ar' {
  return language === 'ar' ? 'ar' : 'en';
}

/**
 * The two links of a campaign mail, on the site in the recipient's language. Attribution rides in
 * the URL only. The walkthrough link carries the same signed trial token as `invite`, so a booking
 * is credited to the recipient only when the token verifies (the API checks it). Arabic has its
 * own path (`/ar`); the other non-English languages ride as `lang=`. The worker's send and the
 * API's preview both build the links here, so the preview shows the links as they will be sent.
 */
export function campaignLinks(
  webPublicUrl: string,
  language: CampaignLanguage,
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
  booking.searchParams.set('invite', trialToken);
  if (language !== 'en' && language !== 'ar') {
    trial.searchParams.set('lang', language);
    booking.searchParams.set('lang', language);
  }
  return { trialUrl: trial.toString(), bookingUrl: booking.toString() };
}
