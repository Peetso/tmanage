import { randomUUID } from 'node:crypto';
import { uuidv7 } from '@tmanage/domain';
import { anchored, plainMailText, signOff } from '@tmanage/mail';
import type { Mailer } from '@tmanage/mail';
import type { PublicLinkCodeRow, PublicLinkRow } from '../../common/database/schema.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { PublicLinkSecrets } from '../public-links/public-link-secrets.js';
import {
  CODE_MAX_ATTEMPTS,
  CODE_TTL_MS,
  MAGIC_SIGNIN_TTL_MS,
  linkStatus,
  maskEmail,
} from '../public-links/public-links.service.js';

/**
 * 55-14 — client portal sign-in by e-mail link (56 §5.15), the screen side's backend.
 *
 * - **Request**: a client types the e-mail their agency invited. The answer is the same 202
 *   whether or not the address can use the portal; only an eligible client (an active, unexpired
 *   client membership in that organization, no internal membership anywhere, no second factor)
 *   is mailed a `magic_signin` public link: 256-bit token, peppered hash, single use, 15 minutes.
 *   A new link revokes the client's earlier live ones, so only the newest works.
 * - **Landing**: `preview` only reads (mail scanners prefetch links); `consume` counts the one
 *   use atomically and hands a user id to the controller, which starts a normal session. A used
 *   link answers the flat 404 of an unknown token.
 * - **Code fallback**: after {@link FAILED_OPENS_FOR_CODE} failed opens in an hour (expired, used
 *   or cancelled link), the next request also mails a 6-digit code bound to the new link.
 * - **"Not you?"**: revokes the link and tells the address.
 * - Every sign-in attempt is an `authentication_events` row with action `magic_link`.
 */

export const MAGIC_LINK_ACTION = 'magic_link';
export const MAGIC_SIGNIN_TARGET = 'client_membership';
export const FAILED_OPENS_FOR_CODE = 3;
export const LINKS_PER_HOUR = 5;
export const FAILED_OPEN_REASONS = ['link_expired', 'link_used', 'link_revoked'] as const;
const HOUR_MS = 3_600_000;
const MAX_EMAIL = 320;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export interface OutsiderMeta {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface EligibleClient {
  readonly userId: string;
  readonly membershipId: string;
  readonly email: string;
}

/** The writes of one service-context transaction for the link's organization. */
export interface PortalSignInTx {
  findLink(linkId: string): Promise<PublicLinkRow | null>;
  insertLink(row: PublicLinkRow): Promise<void>;
  /** Revoke every live magic link of the membership; returns how many. */
  revokeLiveFor(membershipId: string, at: Date): Promise<number>;
  revoke(linkId: string, at: Date): Promise<boolean>;
  /** Atomic `uses < max_uses`; false = already used. */
  recordOpen(linkId: string, at: Date): Promise<boolean>;
  countIssuedSince(membershipId: string, since: Date): Promise<number>;
  newestLiveFor(membershipId: string, at: Date): Promise<PublicLinkRow | null>;
  appendEvent(
    linkId: string,
    kind: string,
    detail: string | null,
    meta: OutsiderMeta,
  ): Promise<void>;
  putCode(linkId: string, codeHash: string, expiresAt: Date, at: Date): Promise<void>;
  findCode(linkId: string): Promise<PublicLinkCodeRow | null>;
  countCodeAttempt(linkId: string): Promise<void>;
  deleteCode(linkId: string): Promise<void>;
  organizationName(): Promise<string>;
  organizationSlug(): Promise<string>;
}

export interface PortalSignInStore {
  findOrganization(slug: string, correlationId: string): Promise<{ readonly id: string } | null>;
  /** Null unless the address is an eligible client of that organization (see the header). */
  findEligibleClient(
    organizationId: string,
    email: string,
    correlationId: string,
  ): Promise<EligibleClient | null>;
  /** Re-checked at use: the membership still active and the user's e-mail still the audience. */
  stillEligible(
    organizationId: string,
    membershipId: string,
    email: string,
    correlationId: string,
  ): Promise<EligibleClient | null>;
  findLinkByHash(
    hash: string,
    correlationId: string,
  ): Promise<{ readonly id: string; readonly organizationId: string } | null>;
  transaction<T>(
    organizationId: string,
    correlationId: string,
    work: (tx: PortalSignInTx) => Promise<T>,
  ): Promise<T>;
  recordAuthEvent(event: {
    readonly userId: string | null;
    readonly outcome: 'succeeded' | 'failed';
    readonly reason: string | null;
    readonly meta: OutsiderMeta;
    readonly correlationId: string;
  }): Promise<void>;
  countFailedOpens(userId: string, since: Date, correlationId: string): Promise<number>;
}

export interface PortalSignInServiceOptions {
  readonly store: PortalSignInStore;
  readonly secrets: PublicLinkSecrets;
  readonly mailer: Mailer | null;
  /** The web origin the mailed link opens on, e.g. `https://tmanage.app`. */
  readonly webOrigin: string;
  readonly now?: () => Date;
}

export type MagicLinkPreview =
  | { readonly state: 'expired' | 'revoked' }
  | {
      readonly state: 'active';
      readonly organizationName: string;
      /** Where the portal lives after sign-in: `/<slug>/portal`. */
      readonly organizationSlug: string;
      readonly audienceHint: string | null;
      readonly expiresAt: string;
    };

/** A proved sign-in: the controller starts the session with this correlation id. */
export interface ProvedSignIn {
  readonly userId: string;
  readonly correlationId: string;
}

interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly language: 'en' | 'ar';
  /** EMAILBUILD: both are security mail (`sender.ts`), never signed by a person. */
  readonly templateKey: 'portal_sign_in' | 'portal_sign_in_cancelled';
}

export class PortalSignInService {
  private readonly now: () => Date;

  constructor(private readonly options: PortalSignInServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Always `{ status: 'sent' }`: the answer never says whether the address is a client. */
  async request(body: unknown, meta: OutsiderMeta): Promise<{ readonly status: 'sent' }> {
    const { orgSlug, email, language } = validateRequest(body);
    const correlationId = randomUUID();
    const { store } = this.options;
    const org = await store.findOrganization(orgSlug, correlationId);
    const client =
      org === null ? null : await store.findEligibleClient(org.id, email, correlationId);
    if (org === null || client === null) {
      await store.recordAuthEvent({
        userId: null,
        outcome: 'failed',
        reason: 'magic_link_not_eligible',
        meta,
        correlationId,
      });
      return { status: 'sent' };
    }
    const at = this.now();
    const failedOpens = await store.countFailedOpens(
      client.userId,
      new Date(at.getTime() - HOUR_MS),
      correlationId,
    );
    const mail = await store.transaction(org.id, correlationId, async (tx) => {
      if (
        (await tx.countIssuedSince(client.membershipId, new Date(at.getTime() - HOUR_MS))) >=
        LINKS_PER_HOUR
      ) {
        return null; // silent: a 429 here would tell an outsider the address is a client
      }
      await tx.revokeLiveFor(client.membershipId, at);
      const secret = this.options.secrets.issueToken();
      const row = magicLinkRow(org.id, client, secret, language, at);
      await tx.insertLink(row);
      await tx.appendEvent(row.id, 'issued', null, meta);
      let code: string | null = null;
      if (failedOpens >= FAILED_OPENS_FOR_CODE) {
        const issued = this.options.secrets.issueCode(row.id);
        await tx.putCode(row.id, issued.hash, new Date(at.getTime() + CODE_TTL_MS), at);
        await tx.appendEvent(row.id, 'code_sent', 'fallback', meta);
        code = issued.code;
      }
      return this.linkMail(client.email, await tx.organizationName(), secret.token, code, language);
    });
    if (mail !== null) await this.send(mail);
    return { status: 'sent' };
  }

  /** Read only: what the landing page shows. A used or unknown token is the same 404. */
  async preview(token: unknown, meta: OutsiderMeta): Promise<MagicLinkPreview> {
    // A refusal is returned, not thrown, so the failed-open row commits before the 404 goes out.
    const outcome = await this.withLink(token, async (tx, link, correlationId) => {
      const at = this.now();
      const failure = failureOf(link, at);
      if (failure !== null) {
        await this.failedOpen(tx, link, failure, meta, correlationId);
        if (failure === 'link_used') return fail(notFound('portal_sign_in.used'));
        return succeed<MagicLinkPreview>({
          state: failure === 'link_revoked' ? 'revoked' : 'expired',
        });
      }
      return succeed<MagicLinkPreview>({
        state: 'active',
        organizationName: await tx.organizationName(),
        organizationSlug: await tx.organizationSlug(),
        audienceHint: maskEmail(link.audienceEmail),
        expiresAt: link.expiresAt.toISOString(),
      });
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /** Spend the link's one use and prove the person. */
  async consume(token: unknown, meta: OutsiderMeta): Promise<ProvedSignIn> {
    const proved = await this.withLink(token, async (tx, link, correlationId) => {
      const at = this.now();
      const failure = failureOf(link, at);
      if (failure !== null) {
        await this.failedOpen(tx, link, failure, meta, correlationId);
        if (failure === 'link_used') return fail(notFound('portal_sign_in.used'));
        return fail(unusable(failure === 'link_revoked' ? 'revoked' : 'expired'));
      }
      const client = await this.options.store.stillEligible(
        link.organizationId,
        link.targetId,
        link.audienceEmail ?? '',
        correlationId,
      );
      if (client === null || !(await tx.recordOpen(link.id, at))) {
        return fail(notFound('portal_sign_in.not_eligible'));
      }
      await tx.appendEvent(link.id, 'opened', 'signed_in', meta);
      return succeed<ProvedSignIn>({ userId: client.userId, correlationId });
    });
    if (!proved.ok) throw proved.error;
    await this.options.store.recordAuthEvent({
      userId: proved.value.userId,
      outcome: 'succeeded',
      reason: null,
      meta,
      correlationId: proved.value.correlationId,
    });
    return proved.value;
  }

  /** The 6-digit fallback: e-mail + code for the client's newest live link. */
  async verifyCode(body: unknown, meta: OutsiderMeta): Promise<ProvedSignIn> {
    const raw = (body ?? {}) as Record<string, unknown>;
    const { orgSlug, email } = validateRequest(raw);
    const correlationId = randomUUID();
    const { store } = this.options;
    const refuse = () => invalid('code', 'is wrong or has expired; ask for a new link');
    const org = await store.findOrganization(orgSlug, correlationId);
    const client =
      org === null ? null : await store.findEligibleClient(org.id, email, correlationId);
    if (org === null || client === null) {
      await store.recordAuthEvent({
        userId: null,
        outcome: 'failed',
        reason: 'code_not_eligible',
        meta,
        correlationId,
      });
      throw refuse();
    }
    const at = this.now();
    const outcome = await store.transaction(org.id, correlationId, async (tx) => {
      const link = await tx.newestLiveFor(client.membershipId, at);
      const stored = link === null ? null : await tx.findCode(link.id);
      if (
        link === null ||
        stored === null ||
        stored.expiresAt <= at ||
        stored.attempts >= CODE_MAX_ATTEMPTS
      ) {
        return 'code_missing' as const;
      }
      if (!this.options.secrets.codeMatches(link.id, raw['code'], stored.codeHash)) {
        await tx.countCodeAttempt(link.id);
        await tx.appendEvent(link.id, 'refused', 'wrong code', meta);
        return 'code_wrong' as const;
      }
      await tx.deleteCode(link.id);
      if (!(await tx.recordOpen(link.id, at))) return 'link_used' as const;
      await tx.appendEvent(link.id, 'code_ok', 'signed_in', meta);
      return null;
    });
    if (outcome !== null) {
      await store.recordAuthEvent({
        userId: client.userId,
        outcome: 'failed',
        reason: outcome,
        meta,
        correlationId,
      });
      throw refuse();
    }
    await store.recordAuthEvent({
      userId: client.userId,
      outcome: 'succeeded',
      reason: 'code_fallback',
      meta,
      correlationId,
    });
    return { userId: client.userId, correlationId };
  }

  /** "Not you?": cancel the link and tell the address. Idempotent on a cancelled link. */
  async notYou(token: unknown, meta: OutsiderMeta): Promise<void> {
    const mail = await this.withLink(token, async (tx, link, correlationId) => {
      const at = this.now();
      if (failureOf(link, at) === 'link_used') throw notFound('portal_sign_in.used');
      if (link.revokedAt !== null) return null;
      await tx.revoke(link.id, at);
      await tx.deleteCode(link.id);
      await tx.appendEvent(link.id, 'not_you', null, meta);
      await this.options.store.recordAuthEvent({
        userId: null,
        outcome: 'failed',
        reason: 'not_you',
        meta,
        correlationId,
      });
      const organizationName = await tx.organizationName();
      return link.audienceEmail === null
        ? null
        : notYouMail(link.audienceEmail, organizationName, link.language === 'ar' ? 'ar' : 'en');
    });
    if (mail !== null) await this.send(mail);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async withLink<T>(
    token: unknown,
    work: (tx: PortalSignInTx, link: PublicLinkRow, correlationId: string) => Promise<T>,
  ): Promise<T> {
    const hash = this.options.secrets.hashPresented(token);
    const correlationId = randomUUID();
    const found =
      hash === null ? null : await this.options.store.findLinkByHash(hash, correlationId);
    if (found === null) throw notFound('portal_sign_in.unknown_token');
    return this.options.store.transaction(found.organizationId, correlationId, async (tx) => {
      const link = await tx.findLink(found.id);
      if (
        link === null ||
        link.kind !== 'magic_signin' ||
        link.targetType !== MAGIC_SIGNIN_TARGET
      ) {
        throw notFound('portal_sign_in.unknown_token');
      }
      return work(tx, link, correlationId);
    });
  }

  private async failedOpen(
    tx: PortalSignInTx,
    link: PublicLinkRow,
    reason: FailedOpenReason,
    meta: OutsiderMeta,
    correlationId: string,
  ): Promise<void> {
    await tx.appendEvent(link.id, 'refused', reason, meta);
    const client = await this.options.store.stillEligible(
      link.organizationId,
      link.targetId,
      link.audienceEmail ?? '',
      correlationId,
    );
    await this.options.store.recordAuthEvent({
      userId: client?.userId ?? null,
      outcome: 'failed',
      reason,
      meta,
      correlationId,
    });
  }

  private linkMail(
    to: string,
    organizationName: string,
    token: string,
    code: string | null,
    language: 'en' | 'ar',
  ): Mail {
    const origin = this.options.webOrigin.replace(/\/+$/u, '');
    const url = `${origin}/portal-sign-in/${token}`;
    const ar = language === 'ar';
    // EMAIL-COPY S7, signed [SEC].
    const lines = ar
      ? [
          `هذا رابط تسجيل دخولك إلى بوابة عملاء ${organizationName}.`,
          `تسجيل الدخول: ${url}`,
          'يعمل مرة واحدة ويتوقف بعد 15 دقيقة.',
          code === null
            ? ''
            : `الرابط لا يفتح؟ استخدم هذا الرمز في صفحة تسجيل الدخول: ${code} (صالح 10 دقائق).`,
          `لست أنت؟ ألغِ هذا الرابط: ${url}?not-you=1`,
        ]
      : [
          `Here is your link to sign in to the ${organizationName} client portal.`,
          `Sign in: ${url}`,
          'It works once and stops working after 15 minutes.',
          code === null
            ? ''
            : `Link not opening? Use this code on the sign-in page instead: ${code} (10 minutes).`,
          `Not you? Cancel this link: ${url}?not-you=1`,
        ];
    return {
      to,
      language,
      subject: anchored(
        language,
        ar
          ? `رابط تسجيل دخولك إلى ${organizationName}`
          : `Your sign-in link for ${organizationName}`,
      ),
      text: plainMailText(language, { lines, signature: signOff('security', language) }),
      templateKey: 'portal_sign_in',
    };
  }

  private async send(mail: Mail): Promise<void> {
    if (this.options.mailer === null) return;
    await this.options.mailer.send(mail);
  }
}

type FailedOpenReason = (typeof FAILED_OPEN_REASONS)[number];

/** Why a link cannot be used now, or null when it can. */
export function failureOf(link: PublicLinkRow, at: Date): FailedOpenReason | null {
  if (link.revokedAt !== null) return 'link_revoked';
  if (link.maxUses !== null && link.uses >= link.maxUses) return 'link_used';
  return linkStatus(link, at) === 'expired' ? 'link_expired' : null;
}

function magicLinkRow(
  organizationId: string,
  client: EligibleClient,
  secret: { readonly hash: string; readonly hint: string },
  language: string,
  at: Date,
): PublicLinkRow {
  return {
    id: uuidv7(),
    organizationId,
    kind: 'magic_signin',
    tokenHash: secret.hash,
    tokenHint: secret.hint,
    targetType: MAGIC_SIGNIN_TARGET,
    targetId: client.membershipId,
    versionHash: null,
    audienceEmail: client.email,
    requireCode: false,
    language,
    expiresAt: new Date(at.getTime() + MAGIC_SIGNIN_TTL_MS),
    maxUses: 1,
    uses: 0,
    decision: null,
    decidedAt: null,
    createdByUserId: null,
    createdAt: at,
    revokedAt: null,
    revokedByUserId: null,
    lastOpenedAt: null,
  };
}

function notYouMail(to: string, organizationName: string, language: 'en' | 'ar'): Mail {
  const ar = language === 'ar';
  // EMAIL-COPY S8, signed [SEC].
  const lines = ar
    ? [
        `أُلغي رابط تسجيل دخول إلى بوابة عملاء ${organizationName} من هذا البريد، ولم يسجّل أحد الدخول به.`,
        'إن أردت تسجيل الدخول، اطلب رابطًا جديدًا من صفحة تسجيل الدخول في البوابة.',
      ]
    : [
        `A sign-in link for the ${organizationName} client portal was cancelled from this mailbox, and nobody signed in with it.`,
        "If you still want to sign in, ask for a new link on the portal's sign-in page.",
      ];
  return {
    to,
    language,
    subject: anchored(
      language,
      ar
        ? `أُلغي رابط تسجيل دخول إلى ${organizationName}`
        : `A sign-in link for ${organizationName} was cancelled`,
    ),
    templateKey: 'portal_sign_in_cancelled',
    text: plainMailText(language, { lines, signature: signOff('security', language) }),
  };
}

export function validateRequest(raw: unknown): {
  readonly orgSlug: string;
  readonly email: string;
  readonly language: 'en' | 'ar';
} {
  const body = (raw ?? {}) as Record<string, unknown>;
  const orgSlug = typeof body['orgSlug'] === 'string' ? body['orgSlug'].trim().toLowerCase() : '';
  if (!SLUG_SHAPE.test(orgSlug)) throw invalid('orgSlug', 'is required');
  const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
  if (email.length > MAX_EMAIL || !EMAIL_SHAPE.test(email)) {
    throw invalid('email', 'must be an e-mail address');
  }
  return { orgSlug, email, language: body['language'] === 'ar' ? 'ar' : 'en' };
}

type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError };

function succeed<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

function fail(error: ApiError): Outcome<never> {
  return { ok: false, error };
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

function notFound(auditCode: string): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, auditCode);
}

function unusable(state: 'expired' | 'revoked'): ApiError {
  return new ApiError(409, 'conflict', 'This link can no longer be used.', [
    { field: 'state', message: state },
  ]);
}
