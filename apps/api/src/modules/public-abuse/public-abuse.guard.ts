import { createHmac } from 'node:crypto';
import { clientAddressKey } from '../../common/http/rate-limiter.js';
import type { AbuseBuckets } from './abuse-buckets.js';
import type { AbuseDecision, AbuseEventKind, AbuseEventStore } from './abuse-events.repository.js';
import type { BlockRuleLookup } from './block-rules.repository.js';
import type { ChallengeService, ChallengeView } from './challenge.service.js';
import { verifyFormProof } from './form-proof.js';
import {
  countUrls,
  emailDomain,
  isDisposableDomain,
  isLanguageMismatch,
  scoreRisk,
} from './risk-score.js';

/**
 * 52-21 — `assessPublicWrite`, the one function every anonymous write door calls (spec 52 §52-21).
 *
 * Order, cheapest refusal first:
 *
 * 1. **Block rules** of the organization the form belongs to (e-mail, domain, IP) → `blocked`.
 * 2. **Windows** in `rate_limit_buckets` — `pub_form_ip` (5 / 10 min, 20 / day) and, for an
 *    organization's form, `pub_form_slug` (200 / day) → `blocked` with `retryAfterSeconds`.
 * 3. **A challenge answer**, when the re-POST carries `challengeId` (+ `code` / `powSolution`) or
 *    a `turnstileToken`: solved → `allow`.
 * 4. **The risk score** (`risk-score.ts`) over the invisible form proof, the honeypot, the
 *    content shape, the 24 h repeat and the IP's day count → `allow | hold | spam`; a hold on a
 *    surface that can render the challenge step (`offerChallenge`) becomes `challenge`.
 *
 * Exactly one `public_abuse_events` row is written per call — the decision, score and reason
 * codes, never content. Recording failures never fail the submission. What each decision *does*
 * is the caller's: the contact form stores a held/spam lead marked; sign-up refuses only
 * `blocked` / `spam` and never holds.
 */

export interface PublicWriteRequest {
  /** `signup`, `contact`, or a public form's slug. */
  readonly surface: string;
  readonly kind: AbuseEventKind;
  readonly body: Readonly<Record<string, unknown>> | null | undefined;
  /** The submitter's e-mail, when the form has one (domain signals, the e-mail code). */
  readonly email?: string | undefined;
  /** Free-text fields: URL count and the repeat fingerprint. */
  readonly texts?: readonly (string | undefined)[];
  readonly ip: string | undefined;
  readonly acceptLanguage?: string | undefined;
  /** The page's language, sent by the page (`pageLocale`) or known to the surface. */
  readonly pageLocale?: string | undefined;
  readonly orgId?: string | undefined;
  /** The surface can render the challenge step (52-20 F-33/F-30). Contact and sign-up cannot. */
  readonly offerChallenge?: boolean;
  readonly correlationId: string;
}

export interface PublicWriteVerdict {
  readonly decision: AbuseDecision;
  readonly score: number;
  readonly reasons: readonly string[];
  /** Set when a window refused: the caller answers 429 with this `Retry-After`. */
  readonly retryAfterSeconds?: number;
  /** Set on `challenge`: the 202 body `{ challenge }` the page renders. */
  readonly challenge?: ChallengeView;
}

export interface PublicAbuseGuardOptions {
  readonly buckets: AbuseBuckets;
  readonly events: AbuseEventStore;
  readonly challenges: ChallengeService;
  readonly blockRules: BlockRuleLookup | null;
  /** The form-proof key (`formProofKey(SESSION_SECRET)`). */
  readonly formProofKey: Buffer;
  /** HMAC key for the repeat fingerprint (`key_hash`). */
  readonly secret: string;
  readonly now?: () => Date;
  readonly purgeEveryMs?: number;
}

export type AssessPublicWrite = (request: PublicWriteRequest) => Promise<PublicWriteVerdict>;

/** Nest token for the process's {@link AssessPublicWrite} (global, from `PublicAbuseModule`). */
export const PUBLIC_ABUSE_ASSESS = Symbol.for('tmanage.PublicAbuseAssess');

const DAY_MS = 24 * 60 * 60 * 1_000;

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export class PublicAbuseGuard {
  private readonly now: () => Date;
  private readonly purgeEveryMs: number;
  private lastPurge = 0;

  constructor(private readonly options: PublicAbuseGuardOptions) {
    this.now = options.now ?? (() => new Date());
    this.purgeEveryMs = options.purgeEveryMs ?? 60 * 60 * 1_000;
  }

  /** The fingerprint of what was submitted: an HMAC, so the content is never stored. */
  keyHash(surface: string, values: readonly (string | undefined)[]): string {
    const normalised = values
      .map((value) => (value ?? '').trim().toLowerCase().replace(/\s+/gu, ' '))
      .join('\u0000');
    return createHmac('sha256', this.options.secret)
      .update(`52-21:values:${surface}\u0000${normalised}`)
      .digest('hex');
  }

  readonly assess: AssessPublicWrite = async (request) => {
    const at = this.now();
    this.maybePurge(at, request.correlationId);
    const body = request.body ?? {};
    // The bucket key: an IPv4 address or an IPv6 /64, as every other limiter here keys it.
    const ip = clientAddressKey(request.ip);
    const email = request.email?.trim().toLowerCase();
    const domain = emailDomain(email);
    const keyHash = this.keyHash(request.surface, [email, ...(request.texts ?? [])]);
    const finish = async (verdict: PublicWriteVerdict): Promise<PublicWriteVerdict> => {
      await this.options.events
        .record(
          {
            kind: request.kind,
            surface: request.surface,
            keyHash,
            ip: request.ip,
            decision: verdict.decision,
            score: verdict.score,
            reasons: verdict.reasons,
            organizationId: request.orgId,
            at,
          },
          request.correlationId,
        )
        .catch(() => undefined);
      return verdict;
    };

    // 1. The organization's own block list.
    if (request.orgId !== undefined && this.options.blockRules !== null) {
      const rule = await this.options
        .blockRules(request.orgId, { email, domain, ip: request.ip }, request.correlationId)
        .catch(() => null);
      if (rule !== null) {
        return finish({ decision: 'blocked', score: 100, reasons: [`block_rule:${rule.kind}`] });
      }
    }

    // 2. The windows.
    const charged = await this.options.buckets.charge([
      { name: 'pub_form_ip', raw: ip },
      ...(request.orgId === undefined
        ? []
        : [{ name: 'pub_form_slug' as const, raw: `${request.orgId}:${request.surface}` }]),
    ]);
    if (!charged.admitted) {
      return finish({
        decision: 'blocked',
        score: 0,
        reasons: charged.refused.map((name) => `limit:${name}`),
        retryAfterSeconds: charged.retryAfterSeconds,
      });
    }

    // 3. A challenge answer.
    const { answered, fallback } = await this.answerChallenge(
      body,
      ip,
      email,
      request.correlationId,
    );
    if (answered === 'solved') {
      return finish({ decision: 'allow', score: 0, reasons: ['challenge_solved'] });
    }
    if (fallback !== undefined) {
      // Turnstile did not answer in time: the e-mail code stands in (SEC-52-20).
      return finish({
        decision: 'challenge',
        score: 0,
        reasons: ['turnstile_unavailable'],
        challenge: fallback,
      });
    }

    // 4. The score.
    const proof = verifyFormProof(this.options.formProofKey, body, at);
    const honeypot = body['website'];
    const repeated = await this.options.events
      .countByKey(request.surface, keyHash, new Date(at.getTime() - DAY_MS), request.correlationId)
      .catch(() => 0);
    const risk = scoreRisk({
      honeypotFilled:
        typeof honeypot === 'string'
          ? honeypot.trim() !== ''
          : honeypot !== undefined && honeypot !== null,
      fillMs: proof.tokenValid ? proof.fillMs : undefined,
      jsProofValid: proof.jsProofValid,
      disposableDomain: isDisposableDomain(domain),
      urlCount: countUrls(request.texts ?? []),
      repeatedWithin24h: repeated > 0,
      ipSubmissionsToday: charged.counts.get('pub_form_ip:d') ?? 0,
      languageMismatch: isLanguageMismatch(
        request.acceptLanguage,
        request.pageLocale ?? text(body['pageLocale']),
      ),
      ipThresholdScale: this.options.buckets.limitScale,
    });
    const reasons = answered === 'wrong' ? [...risk.reasons, 'challenge_wrong'] : risk.reasons;

    if (risk.decision === 'hold' && request.offerChallenge === true) {
      const issued =
        email !== undefined
          ? await this.options.challenges.issueEmailCode({
              email,
              ip,
              correlationId: request.correlationId,
            })
          : await this.options.challenges.issuePow({ correlationId: request.correlationId });
      if (issued.ok) {
        return finish({
          decision: 'challenge',
          score: risk.score,
          reasons,
          challenge: issued.challenge,
        });
      }
    }
    return finish({ decision: risk.decision, score: risk.score, reasons });
  };

  private async answerChallenge(
    body: Readonly<Record<string, unknown>>,
    ip: string,
    email: string | undefined,
    correlationId: string,
  ): Promise<{ answered: 'solved' | 'wrong' | 'none'; fallback?: ChallengeView }> {
    if (body['turnstileToken'] !== undefined) {
      const result = await this.options.challenges.verifyTurnstileOrFallback({
        token: body['turnstileToken'],
        ip,
        email,
        correlationId,
      });
      if (result.outcome === 'fallback') {
        return result.issue?.ok === true
          ? { answered: 'none', fallback: result.issue.challenge }
          : { answered: 'none' };
      }
      return { answered: result.outcome };
    }
    if (body['challengeId'] === undefined) return { answered: 'none' };
    const outcome = await this.options.challenges.answer({
      challengeId: body['challengeId'],
      code: body['code'],
      powSolution: body['powSolution'],
      ip,
      correlationId,
    });
    return { answered: outcome === 'solved' ? 'solved' : 'wrong' };
  }

  /** Hourly, fire-and-forget, from the guard's own calls (56-05's bucket-sweep pattern). */
  private maybePurge(at: Date, correlationId: string): void {
    if (at.getTime() - this.lastPurge < this.purgeEveryMs) return;
    this.lastPurge = at.getTime();
    void this.options.events.purge(at, correlationId).catch(() => undefined);
  }
}
