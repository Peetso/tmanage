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
  };
  readonly directory?: SenderDirectory | undefined;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** The fixed tokens a person mail's sign-off carries; replaced here, never by a producer. */
export const SIGNATURE_TOKENS = Object.freeze({
  name: '[[tm.person.name]]',
  role: '[[tm.person.role]]',
  by: '[[tm.sign.by]]',
  note: '[[tm.sign.note]]',
});

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
    const fill = (value: string, html: boolean): string => {
      const safe = html ? escapeHtml : (text: string) => text;
      return value
        .replaceAll(SIGNATURE_TOKENS.name, safe(identity.person?.name ?? words.team))
        .replaceAll(SIGNATURE_TOKENS.role, safe(identity.person?.role ?? ''))
        .replaceAll(SIGNATURE_TOKENS.by, safe(by))
        .replaceAll(SIGNATURE_TOKENS.note, safe(note));
    };
    const from: MailSender = this.options.sendAs
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
      subject: fill(message.subject, false),
      text: fill(message.text, false),
      ...(message.html === undefined ? {} : { html: fill(message.html, true) }),
      ...(identity.replyTo === null ? {} : { replyTo: identity.replyTo }),
      headers: { ...message.headers, ...autoSubmitted },
    });
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
      case 'person': {
        const person =
          message.personRef === undefined
            ? null
            : await this.personFor(message.organizationId, message.personRef, language);
        if (person === null) return this.mailbox('TManage', hello, 'hello');
        // Person mail leaves through the support login; replies go to the person's own alias.
        return {
          name: words.from(person.name),
          address: person.address,
          replyTo: person.address,
          person,
          mailbox: 'support',
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
    const who = ref.kind === 'test' ? `test:${ref.personId}` : `${ref.userId}:${ref.topic}`;
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
