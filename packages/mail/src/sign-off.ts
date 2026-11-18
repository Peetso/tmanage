import type { MailLanguage } from './sender.js';

/**
 * EMAILBUILD (c) — the shared sign-offs of EMAIL-COPY.md with amendment 1's rules, as lines.
 *
 * - `security` [SEC]: codes, sign-in, security and privacy mail ("TManage Security", no reply).
 * - `notice` [TM]: automatic notifications (no person, no reply invitation) plus the links line.
 * - `support`: support answers, reports, storage and usage notices ("TManage Support", reply-able).
 * - `team`: the welcome ("The TManage team", reply-able, no person).
 * - `person`: tips and reminders; the resolver fills the person's name and honesty line.
 *
 * The links line carries fixed tokens that `NotificationMailTransport` fills with the signed
 * unsubscribe URL; on a path without that transport the resolver drops the line
 * ({@link stripLinkTokens}), so a raw token never reaches a reader. Workspace (agency) mail keeps
 * its own sign-off ({@link workspaceSignOff}).
 */

export type SignOffKind = 'security' | 'notice' | 'support' | 'team' | 'person';

/** The fixed tokens a person mail's sign-off carries; the resolver fills them, never a producer. */
export const SIGNATURE_TOKENS = Object.freeze({
  name: '[[tm.person.name]]',
  role: '[[tm.person.role]]',
  by: '[[tm.sign.by]]',
  note: '[[tm.sign.note]]',
});

export const LINK_TOKENS = Object.freeze({
  settings: '[[tm.link.settings]]',
  unsubscribe: '[[tm.link.unsubscribe]]',
});

const HELP_EN = 'Need help? Write to support@tmanageapp.com.';
const HELP_AR = 'تحتاج إلى مساعدة؟ راسلنا على support@tmanageapp.com.';

const LINKS = {
  en: `Notification settings: ${LINK_TOKENS.settings} | Unsubscribe: ${LINK_TOKENS.unsubscribe}`,
  ar: `إعدادات الإشعارات: ${LINK_TOKENS.settings} | إلغاء الاشتراك: ${LINK_TOKENS.unsubscribe}`,
} as const;

const LINES: Record<MailLanguage, Record<SignOffKind, readonly string[]>> = {
  en: {
    security: [
      'TManage Security',
      `This is an automatic security message, so replies are not read. ${HELP_EN}`,
    ],
    notice: ['TManage', `This is an automatic notification, so replies are not read. ${HELP_EN}`],
    support: ['TManage Support'],
    team: ['The TManage team', 'Reply to this e-mail and we will read it.'],
    person: [SIGNATURE_TOKENS.by, SIGNATURE_TOKENS.note],
  },
  ar: {
    security: ['أمان TManage', `هذه رسالة أمان آلية، والردود عليها لا تُقرأ. ${HELP_AR}`],
    notice: ['TManage', `هذا إشعار آلي، والردود عليه لا تُقرأ. ${HELP_AR}`],
    support: ['دعم TManage'],
    team: ['فريق TManage', 'ردّ على هذه الرسالة وسنقرأ ردّك.'],
    person: [SIGNATURE_TOKENS.by, SIGNATURE_TOKENS.note],
  },
};

/**
 * The sign-off lines. `withLinks` adds the "Notification settings | Unsubscribe" line, for mail
 * that leaves through the notification transport (notices, person mail, owner notices).
 */
export function signOff(
  kind: SignOffKind,
  language: MailLanguage,
  withLinks = kind === 'notice' || kind === 'person',
): readonly string[] {
  const lines = LINES[language][kind];
  return withLinks ? [...lines, LINKS[language]] : lines;
}

/** The text sign-off block, ready to be the last paragraph of a plain-text body. */
export function signOffText(
  kind: SignOffKind,
  language: MailLanguage,
  withLinks?: boolean,
): string {
  return signOff(kind, language, withLinks).join('\n');
}

/** Agency (workspace) sign-off [WS]: "{actor}, {workspace}" then the "sent on behalf" line. */
export function workspaceSignOff(
  language: MailLanguage,
  workspaceName: string,
  replyLine: string,
  actorName?: string,
): readonly string[] {
  const head =
    actorName === undefined || actorName === ''
      ? workspaceName
      : language === 'ar'
        ? `${actorName}، ${workspaceName}`
        : `${actorName}, ${workspaceName}`;
  const sent =
    language === 'ar'
      ? `أرسلها TManage بالنيابة عن ${workspaceName}.`
      : `Sent by TManage on behalf of ${workspaceName}.`;
  return [head, replyLine === '' ? sent : `${sent} ${replyLine}`];
}

/** The three agency reply lines (R1 inviter, R2 request address, R3 portal only). */
export function workspaceReplyLine(
  language: MailLanguage,
  route: 'inviter' | 'requests' | 'none',
  names: {
    readonly actorName?: string;
    readonly workspaceName: string;
    readonly portalLink?: string;
  },
): string {
  if (route === 'inviter' && names.actorName !== undefined && names.actorName !== '') {
    return language === 'ar'
      ? `ردّ على هذه الرسالة لتصل إلى ${names.actorName}.`
      : `Reply to this e-mail to reach ${names.actorName}.`;
  }
  if (route === 'requests') {
    return language === 'ar'
      ? `ردّ على هذه الرسالة لتصل إلى ${names.workspaceName}.`
      : `Reply to this e-mail to reach ${names.workspaceName}.`;
  }
  if (names.portalLink === undefined) {
    return language === 'ar'
      ? 'الردود على هذه الرسالة لا تُقرأ.'
      : 'Replies to this e-mail are not read.';
  }
  return language === 'ar'
    ? `الردود على هذه الرسالة لا تُقرأ. للرد افتح البوابة: ${names.portalLink}`
    : `Replies to this e-mail are not read. To answer, open the portal: ${names.portalLink}`;
}

/** U+200F, the right-to-left mark: keeps a mixed Arabic/Latin line anchored right. */
const RLM = String.fromCodePoint(0x20_0f);

/** An Arabic line (or subject) starts with the RLM; an English one is returned unchanged. */
export function anchored(language: MailLanguage, line: string): string {
  return language === 'ar' && !line.startsWith(RLM) ? `${RLM}${line}` : line;
}

/**
 * A plain-text body in the EMAIL-COPY frame: the greeting, one paragraph per line (Arabic lines
 * anchored right), then the sign-off block. An empty line is dropped, so an optional sentence can
 * be passed as `''`.
 */
export function plainMailText(
  language: MailLanguage,
  body: {
    readonly name?: string;
    readonly lines: readonly string[];
    readonly signature: readonly string[];
  },
): string {
  return [
    anchored(language, greeting(language, body.name)),
    ...body.lines.filter((line) => line !== '').map((line) => anchored(language, line)),
    body.signature.join('\n'),
  ].join('\n\n');
}

/** "Hi {firstName}," from a display name; "Hello," / "مرحبًا،" when there is none. */
export function greeting(language: MailLanguage, displayName: string | undefined): string {
  const first = (displayName ?? '').replaceAll(/\s+/gu, ' ').trim().split(' ')[0] ?? '';
  if (first === '') return language === 'ar' ? 'مرحبًا،' : 'Hello,';
  return language === 'ar' ? `مرحبًا ${first}،` : `Hi ${first},`;
}

/** Drops every line (text) or paragraph (HTML) that still holds an unfilled link token. */
export function stripLinkTokens(value: string, html: boolean): string {
  if (html) return value.replaceAll(/<p\b[^>]*>[^<]*\[\[tm\.link\.[^<]*<\/p>\n?/gu, '');
  return value
    .split('\n')
    .filter(
      (line) => !line.includes(LINK_TOKENS.settings) && !line.includes(LINK_TOKENS.unsubscribe),
    )
    .join('\n');
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** The words of the links line in HTML: each word is the link, no raw URL on show. */
const LINK_WORDS: Record<
  MailLanguage,
  { readonly settings: string; readonly unsubscribe: string }
> = {
  en: { settings: 'Notification settings', unsubscribe: 'Unsubscribe' },
  ar: { settings: 'إعدادات الإشعارات', unsubscribe: 'إلغاء الاشتراك' },
};

/**
 * Fills the link tokens: the bare URL in text. In HTML the links line becomes two linked words
 * ("Notification settings · Unsubscribe"); a token outside that line is a link showing its URL.
 */
export function fillLinkTokens(
  value: string,
  links: { readonly settings: string; readonly unsubscribe: string },
  html: boolean,
): string {
  const anchor = (url: string, label: string): string =>
    `<a href="${escapeAttribute(url)}" style="color:inherit;text-decoration:underline;">${escapeAttribute(label)}</a>`;
  const put = (url: string): string => (html ? anchor(url, url) : url);
  let filled = value;
  if (html) {
    for (const language of ['en', 'ar'] as const) {
      const words = LINK_WORDS[language];
      filled = filled.replaceAll(
        LINKS[language],
        `${anchor(links.settings, words.settings)} · ${anchor(links.unsubscribe, words.unsubscribe)}`,
      );
    }
  }
  return filled
    .replaceAll(LINK_TOKENS.settings, put(links.settings))
    .replaceAll(LINK_TOKENS.unsubscribe, put(links.unsubscribe));
}
