import type {
  MailDelivery,
  MailIdentity,
  Mailer,
  MailMessage,
  MailPersonRef,
  MailSender,
} from './mailer.js';
import {
  MAX_DISPLAY_NAME,
  addressDomain,
  categoryForTemplate,
  cleanDisplayPart,
  validateSenderAddress,
  validateSenderName,
} from './sender.js';
import type { MailLanguage, SenderCategory } from './sender.js';
import {
  SIGNATURE_TOKENS,
  fillLinkTokens,
  hasLinkTokens,
  stripLinkTokens,
  unsubscribeFooter,
} from './sign-off.js';
import { listUnsubscribeHeaders } from './list-unsubscribe.js';

/**
 * EMAILBUILD — the decorator that gives every message its sender.
 *
 * Sits above the queue (or the driver) and below `BounceGuardMailer`/`NotificationMailTransport`,
 * so it sees every message once, after its template key is stamped. It discards any `from` it is
 * handed, maps the template key to a category (`sender.ts`), looks the identity up, and sets
 * `from`, `replyTo` and `Auto-Submitted`. It also fills the fixed signature tokens of a person
 * mail. Any miss or validation failure falls back to "TManage" hello@ (person/welcome) or the
 * no-reply identity (everything else).
 *
 * `sendAs: false` (EMAIL_SEND_AS=off, the default) keeps the SMTP identity's address in `From`
 * and shows only the name; the identity's address goes to Reply-To. `sendAs: true` puts the
 * identity's address in `From` itself, once the host has been proven to accept it.
 */

/** One registry person, in the language asked for. */
export interface MailPerson {
  readonly name: string;
  readonly role: string;
  readonly address: string;
}

/** Where the person for a workspace comes from (the registry, through its own store). */
/**
 * Where the person for a message comes from (the registry, through its own store). `assigned`
 * is the person a user hears from on a topic (picked once, kept); `test` is one registry row, for
 * a platform admin's "Send test" to their own address.
 */
export interface SenderDirectory {
  personFor(
    organizationId: string | undefined,
    ref: MailPersonRef,
    language: MailLanguage,
  ): Promise<MailPerson | null>;
}

export interface SenderResolverOptions {
  /** EMAIL_FROM_ADDRESS — the SMTP identity; its domain is the only one a sender may use. */
  readonly identityAddress: string;
  readonly sendAs: boolean;
  /** The public mailboxes (`CONTACT_EMAILS`). */
  readonly addresses: {
    readonly hello: string;
    readonly support: string;
    readonly noreply: string;
    /** LANE-Q: sales@; absent = the walkthrough request leaves as noreply's "TManage Sales". */
    readonly sales?: string;
  };
  readonly directory?: SenderDirectory | undefined;
  /**
   * PERSONMAIL (ADR-0013). The one-click unsubscribe route (`POST /v1/public/email/unsubscribe`)
   * and its key. With it, EVERY message leaves with `List-Unsubscribe` + `List-Unsubscribe-Post`
   * and a footer holding "Notification settings" and "Unsubscribe"; mail the notification transport
   * already stamped is left as it is. Absent (a suite) = the unfilled links line is dropped.
   */
  readonly unsubscribe?: { readonly url: string; readonly key: Buffer } | undefined;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export { SIGNATURE_TOKENS } from './sign-off.js';

const CACHE_MS = 60_000;
const NO_AUTO_SUBMITTED = new Set(['platform_owner_notice']);
/** A producer's Reply-To (an inviter's own address): one plain address, no header tricks. */
const REPLY_ADDRESS = /^[^\s@<>"(),;:\\]{1,64}@[^\s@<>"(),;:\\]{1,189}$/u;

interface Identity {
  readonly name: string;
  readonly address: string;
  readonly replyTo: string | null;
  readonly person: MailPerson | null;
  /** The mailbox login it leaves through (amendment 3). */
  readonly mailbox: MailIdentity;
}

const WORDS = {
  en: {
    security: 'TManage Security',
    support: 'TManage Support',
    sales: 'TManage Sales',
    team: 'The TManage team',
    from: (name: string) => `${name} from TManage`,
    via: (workspace: string) => `${workspace} via TManage`,
    at: (actor: string, workspace: string) => `${actor} at ${workspace} via TManage`,
    by: (person: MailPerson) => `${person.name}, ${person.role} at TManage`,
    note: (person: MailPerson) =>
      `Sent automatically in ${person.name}'s name. Reply to this e-mail and our team will read it.`,
    teamNote: 'Reply to this e-mail and we will read it.',
  },
  ar: {
    security: 'أمان TManage',
    support: 'دعم TManage',
    sales: 'مبيعات TManage',
    team: 'فريق TManage',
    from: (name: string) => `${name} من TManage`,
    via: (workspace: string) => `${workspace} عبر TManage`,
    at: (actor: string, workspace: string) => `${actor} من ${workspace} عبر TManage`,
    by: (person: MailPerson) => `${person.name}، ${person.role} في TManage`,
    note: (person: MailPerson) =>
      `أُرسلت هذه الرسالة آليًا باسم ${person.name}. ردّ عليها وسيقرأ فريقنا ردّك.`,
    teamNote: 'ردّ على هذه الرسالة وسنقرأ ردّك.',
  },
} as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * PERSONMAIL. `value` with the footer lines added, unless it already holds a links line (the
 * sign-off of a notice or a tip). Text: a blank line, then the lines. HTML: one small paragraph
 * per line, before `</body>` when there is one.
 */
function withFooter(value: string, html: boolean, lines: readonly string[]): string {
  if (hasLinkTokens(value)) return value;
  if (!html) return `${value.replace(/\s+$/u, '')}\n\n${lines.join('\n')}`;
  const block = lines
    .map((line) => `<p style="font-size:12px;line-height:18px;color:#6b6b6b;">${line}</p>`)
    .join('\n');
  const end = value.toLowerCase().lastIndexOf('</body>');
  return end < 0 ? `${value}\n${block}` : `${value.slice(0, end)}${block}\n${value.slice(end)}`;
}

export class SenderResolvingMailer implements Mailer {
  private readonly cache = new Map<string, { at: number; person: MailPerson | null }>();
  private readonly domain: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly inner: Mailer,
    private readonly options: SenderResolverOptions,
  ) {
    this.domain = addressDomain(options.identityAddress);
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line) => console.warn(line));
  }

  async send(incoming: MailMessage): Promise<MailDelivery> {
    // Whatever arrived in `from` is discarded: only this resolver names a sender.
    const { from: _discarded, identity: _discardedIdentity, ...message } = incoming;
    const language: MailLanguage = message.language === 'ar' ? 'ar' : 'en';
    const category = categoryForTemplate(message.templateKey, message.audience);
    const identity = await this.identityFor(category, message, language);
    const words = WORDS[language];
    const by = identity.person === null ? words.team : words.by(identity.person);
    const note = identity.person === null ? words.teamNote : words.note(identity.person);
    const stamp = this.unsubscribeFor(message);
    const linked = (value: string, html: boolean, body: boolean): string => {
      if (stamp === null || !body) return stripLinkTokens(value, html);
      return fillLinkTokens(
        stamp.footer ? withFooter(value, html, stamp.lines) : value,
        stamp.links,
        html,
      );
    };
    const fill = (value: string, html: boolean, body = true): string => {
      const safe = html ? escapeHtml : (text: string) => text;
      // The links line is filled (every mail has one, ADR-0013); without the unsubscribe route
      // configured, an unfilled one is dropped so a raw token never reaches a reader.
      return linked(value, html, body)
        .replaceAll(SIGNATURE_TOKENS.name, safe(identity.person?.name ?? words.team))
        .replaceAll(SIGNATURE_TOKENS.role, safe(identity.person?.role ?? ''))
        .replaceAll(SIGNATURE_TOKENS.by, safe(by))
        .replaceAll(SIGNATURE_TOKENS.note, safe(note));
    };
    // PERSONMAIL: a person mail always names the person's own mailbox; the identity router sends
    // it from there, or drops the address when it falls back to the support login.
    const from: MailSender =
      this.options.sendAs || identity.mailbox === 'person'
        ? { name: identity.name, address: identity.address }
        : { name: identity.name };
    const { replyTo: _producerReplyTo, ...rest } = message;
    const autoSubmitted =
      typeof message.templateKey === 'string' && NO_AUTO_SUBMITTED.has(message.templateKey)
        ? {}
        : { 'Auto-Submitted': 'auto-generated' };
    return this.inner.send({
      ...rest,
      from,
      identity: identity.mailbox,
      subject: fill(message.subject, false, false),
      text: fill(message.text, false),
      ...(message.html === undefined ? {} : { html: fill(message.html, true) }),
      ...(identity.replyTo === null ? {} : { replyTo: identity.replyTo }),
      headers: { ...message.headers, ...(stamp?.headers ?? {}), ...autoSubmitted },
    });
  }

  /**
   * PERSONMAIL (ADR-0013). The unsubscribe headers and links for one message, or `null` without
   * the route configured. A message the notification transport already stamped keeps its headers
   * and its filled links line (`footer: false`); every other one gets both here. Mail that is not
   * optional gets the honest footer: the link stops optional mail, account mail still comes.
   */
  private unsubscribeFor(message: MailMessage): {
    readonly headers: Readonly<Record<string, string>>;
    readonly links: { readonly settings: string; readonly unsubscribe: string };
    readonly footer: boolean;
    readonly lines: readonly string[];
  } | null {
    const route = this.options.unsubscribe;
    if (route === undefined) return null;
    const stamped = message.headers?.['List-Unsubscribe'];
    const headers =
      stamped === undefined ? listUnsubscribeHeaders(route.url, route.key, message.to) : {};
    for (const value of Object.values(headers)) {
      if (/[\r\n]/u.test(value)) throw new Error('refused a header value holding a line break');
    }
    const header = stamped ?? headers['List-Unsubscribe'] ?? '';
    const settings = new URL(route.url);
    settings.search = '';
    const language: MailLanguage = message.language === 'ar' ? 'ar' : 'en';
    return {
      headers,
      links: { settings: settings.toString(), unsubscribe: /^<(.*)>$/u.exec(header)?.[1] ?? '' },
      footer: stamped === undefined,
      lines: unsubscribeFooter(language, message.optional !== true),
    };
  }

  private usable(address: string): boolean {
    return validateSenderAddress(address, this.domain);
  }

  /** The no-reply identity, or the SMTP identity itself when noreply@ is on another domain. */
  private noreply(name: string): Identity {
    const address = this.usable(this.options.addresses.noreply)
      ? this.options.addresses.noreply
      : this.options.identityAddress;
    return { name, address, replyTo: null, person: null, mailbox: 'noreply' };
  }

  private mailbox(name: string, address: string, mailbox: MailIdentity): Identity {
    return this.usable(address)
      ? { name, address, replyTo: address, person: null, mailbox }
      : this.noreply(name);
  }

  private async identityFor(
    category: SenderCategory,
    message: MailMessage,
    language: MailLanguage,
  ): Promise<Identity> {
    const words = WORDS[language];
    const { hello, support } = this.options.addresses;
    switch (category) {
      case 'welcome':
        return this.mailbox('TManage', hello, 'hello');
      case 'support':
        return this.mailbox(words.support, support, 'support');
      case 'sales':
        return this.sales(message, words.sales);
      case 'person': {
        const person =
          message.personRef === undefined
            ? null
            : await this.personFor(message.organizationId, message.personRef, language);
        if (person === null) return this.mailbox('TManage', hello, 'hello');
        // PERSONMAIL (ADR-0013): person mail leaves from the person's own mailbox; the identity
        // router falls back to the support login (From support@, Reply-To the person) without one.
        return {
          name: words.from(person.name),
          address: person.address,
          replyTo: person.address,
          person,
          mailbox: 'person',
        };
      }
      case 'workspace':
        return this.workspace(message, language);
      case 'notice':
      case 'internal':
        return this.noreply('TManage');
      case 'security':
        return this.noreply(words.security);
    }
  }

  /**
   * LANE-Q. sales@ writes to the sales team about a visitor's request. The producer's Reply-To
   * (the visitor's own address, server-checked) survives only as one plain address, so the team
   * answers the visitor with Reply; anything else replies to sales@ itself.
   */
  private sales(message: MailMessage, name: string): Identity {
    const address = this.options.addresses.sales;
    const base = address === undefined ? this.noreply(name) : this.mailbox(name, address, 'sales');
    const reply = message.replyTo?.trim();
    return reply !== undefined && REPLY_ADDRESS.test(reply) ? { ...base, replyTo: reply } : base;
  }

  private workspace(message: MailMessage, language: MailLanguage): Identity {
    const words = WORDS[language];
    const acting = message.actingFor;
    const workspace = acting === undefined ? '' : cleanDisplayPart(acting.workspaceName);
    const actor = acting?.actorName === undefined ? '' : cleanDisplayPart(acting.actorName);
    const composed =
      workspace === ''
        ? 'TManage'
        : actor === ''
          ? words.via(workspace)
          : words.at(actor, workspace);
    const name = validateSenderName(composed, MAX_DISPLAY_NAME) ? composed : 'TManage';
    const base = this.noreply(name);
    // The producer's Reply-To is server-built (the inviter, the workspace's request address);
    // it survives only when the route says so and it is a well-formed address.
    const reply = message.replyTo?.trim();
    const keep = acting?.replyRoute !== 'none' && reply !== undefined && REPLY_ADDRESS.test(reply);
    return keep ? { ...base, replyTo: reply } : base;
  }

  private async personFor(
    organizationId: string | undefined,
    ref: MailPersonRef,
    language: MailLanguage,
  ): Promise<MailPerson | null> {
    const directory = this.options.directory;
    if (directory === undefined) return null;
    const who =
      ref.kind === 'assigned' ? `${ref.userId}:${ref.topic}` : `${ref.kind}:${ref.personId}`;
    const key = `${organizationId ?? '-'}:${who}:${language}`;
    const at = this.now();
    const cached = this.cache.get(key);
    if (cached !== undefined && at - cached.at < CACHE_MS) return cached.person;
    let person: MailPerson | null = null;
    try {
      const found = await directory.personFor(organizationId, ref, language);
      person =
        found !== null &&
        validateSenderName(found.name) &&
        validateSenderName(found.role) &&
        validateSenderName(this.wordsFrom(found.name, language), MAX_DISPLAY_NAME) &&
        this.usable(found.address)
          ? found
          : null;
    } catch {
      this.log('[mailer] sender directory lookup failed; signing as the TManage team');
    }
    this.cache.set(key, { at, person });
    return person;
  }

  private wordsFrom(name: string, language: MailLanguage): string {
    return WORDS[language].from(name);
  }
}
