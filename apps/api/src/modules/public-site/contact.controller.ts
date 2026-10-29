import { Body, Controller, HttpCode, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { ApiError } from '../../common/http/errors.js';
import { Public } from '../../common/http/decorators.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { CONTACT_ADMISSION, MARKETING_LEADS_REPOSITORY } from '../../common/http/tokens.js';
import { clientAddressKey, type RequestAdmission } from '../../common/http/rate-limiter.js';
import type { MarketingLeadsRepository } from './contact.repository.js';
import { PUBLIC_ABUSE_ASSESS } from '../public-abuse/public-abuse.guard.js';
import type { AssessPublicWrite } from '../public-abuse/public-abuse.guard.js';

/** Column bounds, mirrored from `0062_marketing_leads.sql`. Over-length is a 400, never a truncation. */
const MAX_NAME = 200;
const MAX_EMAIL = 254;
const MAX_MESSAGE = 4000;

/**
 * A deliberately conservative email shape: one `@`, at least one character before it, and a dotted
 * domain after it, no whitespace. This is a *shape* check, not deliverability — the point is to
 * reject obvious rubbish at the boundary, not to guarantee the address exists.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The one field a lead submission carries per field; the body is untrusted, so every value is `unknown`. */
interface ContactSubmitBody {
  readonly name?: unknown;
  readonly email?: unknown;
  readonly message?: unknown;
  /** 52-21's invisible inputs (`startedAt`, `nonce`, `proof`, `website`, `pageLocale`). */
  readonly [proofField: string]: unknown;
}

/**
 * The response the contact form gets back. Deliberately opaque: it acknowledges receipt and
 * reflects **nothing** that was stored — not the lead's id, not the submitted values, and never
 * any other lead. A public write door has no business handing data back.
 */
export interface ContactSubmitView {
  /**
   * `received` — stored (a held or spam lead is stored too, marked, and is answered the same so a
   * script learns nothing). `not_sent` — a 200 the form shows as its calm "could not send": the
   * organization's block list or a 52-21 window refused it, and nothing was stored.
   */
  readonly status: 'received' | 'not_sent';
}

/**
 * x161 — the public site's contact / lead intake (Public site module 1, audit rank #1).
 *
 * `POST /public/site/contact` is the module's *only unauthenticated write*, so the whole slice is
 * about the untrusted-input boundary. The route is `@Public()`: it establishes no authority and
 * exercises none, so it carries no session, no CSRF token, no tenant and no capability — the same
 * posture as sign-in, which is the only other unauthenticated write in the application.
 *
 * The discipline the door keeps:
 *
 *  - **Validate and bound every field, 400 with no write on bad input.** Empty, non-string or
 *    over-length name/email/message, or an email that is not even shaped like one, is a
 *    `validation_failed` 400 raised *before* the repository is ever called — asserted in
 *    `contact.controller.test.ts`.
 *  - **No PII in the URL.** Everything is in the POST body; there is no query string and nothing
 *    is logged into one.
 *  - **Rate-limited per address.** Each `request.ip` (what `trustProxy` resolves it to) gets a
 *    small fixed window of submissions; the one over it is a 429 before validation or any write,
 *    so a flood cannot fill `marketing_leads` (pre-launch security review 2026-10-17, §3).
 *  - **Write-only.** There is no GET/list/read handler here and no read method on the repository:
 *    a lead is written and, in this slice, never read back over HTTP.
 *
 * Email delivery of the lead is Needs-Peter (an external mail provider); this slice persists only.
 *
 * 52-21: after validation the submission is assessed by the abuse engine (`assessPublicWrite`):
 * `allow` stores the lead as before; `hold` and `spam` store it marked (`review_status`), never
 * delivered, and answer the same `received`; `blocked` stores nothing and answers the calm 200
 * `not_sent` (or the 429 when a window refused). The form cannot render a challenge yet (F-33/F-30
 * are 52-20's), so a person is never shown one here.
 */
@Controller('public/site')
export class ContactController {
  constructor(
    @Inject(MARKETING_LEADS_REPOSITORY) private readonly leads: MarketingLeadsRepository,
    @Inject(CONTACT_ADMISSION) private readonly admit: RequestAdmission,
    // 52-21. Absent (a hand-built controller) means every valid submission is stored clear.
    @Optional()
    @Inject(PUBLIC_ABUSE_ASSESS)
    private readonly assess?: AssessPublicWrite,
  ) {}

  @Post('contact')
  @Public()
  @HttpCode(201)
  async submit(
    @Body() body: ContactSubmitBody,
    @Req() request: { headers: Record<string, string | string[] | undefined>; ip?: string },
    @Res({ passthrough: true }) reply?: { status(code: number): unknown },
  ): Promise<ContactSubmitView> {
    const state = requireRequestState(request);
    if (!this.admit(clientAddressKey(request.ip))) {
      // Before validation and before the repository: a refused caller costs one map lookup.
      throw new ApiError(429, 'rate_limited', 'too many submissions; try again later');
    }

    const name = boundedText(body?.name, MAX_NAME);
    const email = boundedText(body?.email, MAX_EMAIL);
    const message = boundedText(body?.message, MAX_MESSAGE);

    const details: { field: string; message: string }[] = [];
    if (name === undefined)
      details.push({ field: 'name', message: `required, 1–${MAX_NAME} chars` });
    if (email === undefined) {
      details.push({ field: 'email', message: `required, 1–${MAX_EMAIL} chars` });
    } else if (!EMAIL_SHAPE.test(email)) {
      details.push({ field: 'email', message: 'must be a valid email address' });
    }
    if (message === undefined) {
      details.push({ field: 'message', message: `required, 1–${MAX_MESSAGE} chars` });
    }

    if (details.length > 0 || name === undefined || email === undefined || message === undefined) {
      // A shape error, not an authorization one, so it is allowed to be specific. Nothing is
      // written: the repository is not reached on this path.
      throw new ApiError(400, 'validation_failed', 'name, email and message are required', details);
    }

    const acceptLanguage = request.headers['accept-language'];
    const verdict = await this.assess?.({
      surface: 'contact',
      kind: 'contact',
      body: body ?? {},
      email,
      texts: [name, message],
      ip: request.ip,
      acceptLanguage: typeof acceptLanguage === 'string' ? acceptLanguage : undefined,
      correlationId: state.correlationId,
    });
    if (verdict?.decision === 'blocked') {
      if (verdict.retryAfterSeconds !== undefined) {
        throw new ApiError(429, 'rate_limited', 'too many submissions; try again later');
      }
      reply?.status(200);
      return { status: 'not_sent' };
    }

    await this.leads.insert({
      name,
      email,
      message,
      source: 'contact_form',
      reviewStatus:
        verdict === undefined || verdict.decision === 'allow'
          ? 'clear'
          : verdict.decision === 'spam'
            ? 'spam'
            : 'held',
      correlationId: state.correlationId,
    });

    return { status: 'received' };
  }
}

/**
 * A trimmed string of 1..=max characters, or `undefined` when the value is absent, not a string,
 * empty after trimming, or longer than the bound. Length is measured on the trimmed value, the same
 * value that is stored, so a field that fits the column can never be rejected and a rejected one is
 * never stored.
 */
function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}
