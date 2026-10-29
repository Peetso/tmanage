import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { uuidv7 } from '@tmanage/domain';
import type { Mailer } from '@tmanage/mail';
import type { AbuseBuckets } from './abuse-buckets.js';
import type { ChallengeKind, ChallengeStore } from './abuse-events.repository.js';
import { POW_MAX_BITS, POW_MIN_BITS, adaptiveDifficulty, powSalt, verifyPow } from './pow.js';
import { verifyTurnstile } from './turnstile.js';
import type { FetchLike } from './turnstile.js';

/**
 * 52-21 — the challenges a held submission can answer (spec §16.4 UX flow; the visible step is
 * 52-20's F-33/F-30). The contract the page renders is {@link ChallengeView}, sent in a 202
 * `{ challenge }`; the page answers by re-POSTing the same submission with `challengeId` and
 * `code` (or `powSolution` / `turnstileToken`) — no extra public route.
 *
 * - **E-mail code** — 4 digits, stored as an HMAC (never the code), 10-minute expiry, 5 attempts,
 *   a resend only after 60 s, sent through the app's mailer as a transactional message. Sends are
 *   bounded per address (`pub_otp_email`), per IP (`pub_otp_ip`) and platform-wide per hour
 *   (`pub_otp_budget_hour`, which raises `otp_budget:80pct` exactly once per hour at 80 %).
 * - **Proof-of-work** — see `pow.ts`; the difficulty is recorded as an HMAC so it cannot be lowered.
 * - **Turnstile** — `turnstile.ts`; an outage (no answer in 3 s) falls back to the e-mail code.
 */

export const EMAIL_CODE_TTL_MS = 10 * 60 * 1_000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const RESEND_AFTER_MS = 60 * 1_000;
export const POW_TTL_MS = 5 * 60 * 1_000;
export const OTP_BUDGET_ALERT_KIND = 'otp_budget:80pct';

export interface ChallengeView {
  readonly kind: ChallengeKind;
  readonly challengeId: string;
  readonly resendAfterSeconds: number;
  /** Proof-of-work only. */
  readonly salt?: string;
  readonly bits?: number;
}

export type IssueOutcome =
  | { readonly ok: true; readonly challenge: ChallengeView }
  | { readonly ok: false; readonly reason: 'rate_limited'; readonly retryAfterSeconds: number };

export type AnswerOutcome = 'solved' | 'wrong' | 'expired' | 'locked' | 'rate_limited';

export interface AlertSink {
  notify(kind: string, facts?: { readonly detail?: string }): Promise<unknown>;
}

export interface ChallengeServiceOptions {
  readonly store: ChallengeStore;
  readonly buckets: AbuseBuckets;
  /** HMAC key for targets and codes. Never logged. */
  readonly secret: string;
  readonly mailer: Mailer | null;
  readonly alerts?: AlertSink | null;
  /** The decrypted `turnstile_secret`, or null when Turnstile is not configured. */
  readonly turnstileSecret?: () => Promise<string | null>;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  readonly randomCode?: () => string;
}

export interface TurnstileAnswer {
  readonly outcome: 'solved' | 'wrong';
}
export type TurnstileOrFallback =
  TurnstileAnswer | { readonly outcome: 'fallback'; readonly issue: IssueOutcome | null };

function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class ChallengeService {
  private readonly now: () => Date;
  private readonly randomCode: () => string;

  constructor(private readonly options: ChallengeServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.randomCode = options.randomCode ?? (() => String(randomInt(0, 10_000)).padStart(4, '0'));
  }

  hash(purpose: string, value: string): string {
    return createHmac('sha256', this.options.secret)
      .update(`52-21:${purpose}:${value}`)
      .digest('hex');
  }

  async issueEmailCode(input: {
    readonly email: string;
    readonly ip: string;
    readonly correlationId: string;
  }): Promise<IssueOutcome> {
    const at = this.now();
    const email = input.email.trim().toLowerCase();
    const target = this.hash('email', email);
    const open = await this.options.store.latestOpen('email_code', target, at, input.correlationId);
    if (open !== null && at.getTime() - open.createdAt.getTime() < RESEND_AFTER_MS) {
      // Too soon to send another: the page keeps the challenge it has.
      const wait = RESEND_AFTER_MS - (at.getTime() - open.createdAt.getTime());
      return {
        ok: true,
        challenge: {
          kind: 'email_code',
          challengeId: open.id,
          resendAfterSeconds: Math.ceil(wait / 1_000),
        },
      };
    }

    const charged = await this.options.buckets.charge([
      { name: 'pub_otp_email', raw: email },
      { name: 'pub_otp_ip', raw: input.ip },
      { name: 'pub_otp_budget_hour', raw: 'all' },
    ]);
    if (!charged.admitted) {
      return { ok: false, reason: 'rate_limited', retryAfterSeconds: charged.retryAfterSeconds };
    }
    const budgetCount = charged.counts.get('pub_otp_budget_hour:h') ?? 0;
    const alertAt = Math.ceil(this.options.buckets.max('pub_otp_budget_hour', 'h') * 0.8);
    if (budgetCount === alertAt) {
      // Exactly one charge in the hour sees the crossing count, on any process: one alert.
      void this.options.alerts
        ?.notify(OTP_BUDGET_ALERT_KIND, { detail: `${budgetCount} codes this hour` })
        .catch(() => undefined);
    }

    const code = this.randomCode();
    const id = uuidv7();
    await this.options.store.insert(
      {
        id,
        kind: 'email_code',
        targetHash: target,
        codeHash: this.hash('code', `${id}:${code}`),
        attempts: 0,
        expiresAt: new Date(at.getTime() + EMAIL_CODE_TTL_MS),
        solvedAt: null,
        createdAt: at,
      },
      input.correlationId,
    );
    if (this.options.mailer !== null) {
      try {
        await this.options.mailer.send({
          to: email,
          subject: `Your TManage code: ${code}`,
          text:
            `Your TManage code is ${code}.\n\n` +
            'It works for 10 minutes. If you did not ask for it, you can ignore this message.',
        });
      } catch {
        // The challenge stands; the person can ask for a resend after a minute.
      }
    }
    return {
      ok: true,
      challenge: {
        kind: 'email_code',
        challengeId: id,
        resendAfterSeconds: RESEND_AFTER_MS / 1_000,
      },
    };
  }

  async issuePow(input: { readonly correlationId: string }): Promise<IssueOutcome> {
    const at = this.now();
    const charged = await this.options.buckets.charge([{ name: 'pub_pow_minute', raw: 'all' }]);
    const issued = charged.admitted ? (charged.counts.get('pub_pow_minute:m') ?? 1) : Infinity;
    const bits = adaptiveDifficulty(issued);
    const id = uuidv7();
    await this.options.store.insert(
      {
        id,
        kind: 'pow',
        targetHash: this.hash('pow-target', id),
        codeHash: this.hash('pow-bits', `${id}:${bits}`),
        attempts: 0,
        expiresAt: new Date(at.getTime() + POW_TTL_MS),
        solvedAt: null,
        createdAt: at,
      },
      input.correlationId,
    );
    return {
      ok: true,
      challenge: {
        kind: 'pow',
        challengeId: id,
        resendAfterSeconds: 0,
        salt: powSalt(this.options.secret, id),
        bits,
      },
    };
  }

  /** Answer an e-mail code or a proof-of-work challenge. Single use: a solved one is spent. */
  async answer(input: {
    readonly challengeId: unknown;
    readonly code?: unknown;
    readonly powSolution?: unknown;
    readonly ip: string;
    readonly correlationId: string;
  }): Promise<AnswerOutcome> {
    if (typeof input.challengeId !== 'string' || !/^[0-9a-f-]{36}$/u.test(input.challengeId)) {
      return 'expired';
    }
    const challengeId = input.challengeId;
    const charged = await this.options.buckets.charge([
      { name: 'pub_verify_ip', raw: input.ip },
      { name: 'pub_otp_verify_token', raw: challengeId },
    ]);
    if (!charged.admitted) return 'rate_limited';

    const at = this.now();
    const challenge = await this.options.store.find(challengeId, input.correlationId);
    if (
      challenge === null ||
      challenge.solvedAt !== null ||
      challenge.expiresAt.getTime() <= at.getTime()
    ) {
      return 'expired';
    }
    if (challenge.kind === 'email_code') {
      if (challenge.attempts >= EMAIL_CODE_MAX_ATTEMPTS) return 'locked';
      const attempts = await this.options.store.addAttempt(challengeId, input.correlationId);
      if (attempts > EMAIL_CODE_MAX_ATTEMPTS) return 'locked';
      const code = typeof input.code === 'string' ? input.code.trim() : '';
      if (!/^\d{4}$/u.test(code) || challenge.codeHash === null) return 'wrong';
      if (!safeEqualText(challenge.codeHash, this.hash('code', `${challengeId}:${code}`))) {
        return attempts >= EMAIL_CODE_MAX_ATTEMPTS ? 'locked' : 'wrong';
      }
    } else if (challenge.kind === 'pow') {
      const bits = this.powBits(challengeId, challenge.codeHash);
      if (bits === null) return 'expired';
      if (!verifyPow(powSalt(this.options.secret, challengeId), input.powSolution, bits)) {
        return 'wrong';
      }
    } else {
      return 'expired';
    }
    return (await this.options.store.markSolved(challengeId, at, input.correlationId))
      ? 'solved'
      : 'expired';
  }

  /**
   * Turnstile, failing open to the e-mail code (SEC-52-20): an outage or a missing secret issues an
   * e-mail code to `email` instead (or `issue: null` when there is no address to send it to).
   */
  async verifyTurnstileOrFallback(input: {
    readonly token: unknown;
    readonly ip: string;
    readonly email?: string | undefined;
    readonly correlationId: string;
  }): Promise<TurnstileOrFallback> {
    const secret = (await this.options.turnstileSecret?.().catch(() => null)) ?? null;
    const outcome = await verifyTurnstile({
      secret,
      token: input.token,
      remoteIp: input.ip,
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    });
    if (outcome === 'pass') return { outcome: 'solved' };
    if (outcome === 'fail') return { outcome: 'wrong' };
    const issue =
      input.email === undefined
        ? null
        : await this.issueEmailCode({
            email: input.email,
            ip: input.ip,
            correlationId: input.correlationId,
          });
    return { outcome: 'fallback', issue };
  }

  /** The difficulty a challenge was issued at: the one whose HMAC matches. */
  private powBits(challengeId: string, codeHash: string | null): number | null {
    if (codeHash === null) return null;
    for (let bits = POW_MIN_BITS; bits <= POW_MAX_BITS; bits += 1) {
      if (safeEqualText(codeHash, this.hash('pow-bits', `${challengeId}:${bits}`))) return bits;
    }
    return null;
  }
}
