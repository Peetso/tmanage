import { Controller, Get, Inject, Res } from '@nestjs/common';
import { Public } from '../../common/http/decorators.js';
import { PUBLIC_LINK_VIEW_LIMITS, Throttle } from '../rate-limits/throttle-policies.js';
import { issueFormProof } from './form-proof.js';

export const FORM_PROOF_KEY = Symbol.for('tmanage.FormProofKey');

/** `GET /v1/public/form-proof` — mirrored by `apps/web/src/lib/form-proof.ts`. */
export interface FormProofView {
  readonly startedAt: string;
  readonly nonce: string;
}

/**
 * 52-21 — the one public route the abuse engine adds: a fresh signed `startedAt` and nonce for a
 * public form that is being shown (see `form-proof.ts`). Stateless: nothing is stored. Throttled
 * like a public link view; never cached, never indexed, never sent on as a referrer.
 */
@Controller('v1/public/form-proof')
export class FormProofController {
  constructor(@Inject(FORM_PROOF_KEY) private readonly key: Buffer) {}

  @Get()
  @Public()
  @Throttle('form_proof', PUBLIC_LINK_VIEW_LIMITS)
  issue(
    @Res({ passthrough: true }) reply: { header(name: string, value: string): unknown },
  ): FormProofView {
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex');
    reply.header('referrer-policy', 'no-referrer');
    return issueFormProof(this.key);
  }
}
