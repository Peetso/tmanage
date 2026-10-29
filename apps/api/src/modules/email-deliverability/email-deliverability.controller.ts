import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { HOST_MAIL_CEILING } from '@tmanage/mail';
import type { SendCeiling } from '@tmanage/mail';
import { NoTenant } from '../../common/http/decorators.js';
import { PlatformAdminGuard } from '../platform-admin/platform-admin.guard.js';
import { RequirePlatformPermission } from '../platform-admin/require-platform-permission.decorator.js';
import { checkDomainAuth } from './domain-auth.js';
import type { DomainAuthReport, TxtResolver } from './domain-auth.js';

export const EMAIL_DELIVERABILITY_READER = Symbol.for('tmanage.EmailDeliverabilityReader');

const CACHE_MS = 60 * 60 * 1000;

export interface EmailDeliverabilityView {
  /** `null` when `EMAIL_FROM_ADDRESS` names no usable domain. */
  readonly auth: DomainAuthReport | null;
  /** The per-process send ceiling the relay enforces (§9.2). */
  readonly sendCeiling: SendCeiling;
}

/**
 * 51-11 — the DNS reading, cached one hour per process so a screen refresh or a monitor poll
 * costs no lookup. Shared by the platform route below and (via the fragment) `/healthz/deep`.
 */
export class EmailDeliverabilityReader {
  private cached: { at: number; view: EmailDeliverabilityView } | null = null;

  constructor(
    private readonly domain: string | null,
    private readonly selectors: readonly string[] | undefined,
    private readonly resolver?: TxtResolver,
    private readonly now: () => number = Date.now,
  ) {}

  async read(): Promise<EmailDeliverabilityView> {
    const at = this.now();
    if (this.cached !== null && at - this.cached.at < CACHE_MS) return this.cached.view;
    const auth =
      this.domain === null
        ? null
        : await checkDomainAuth(this.domain, {
            ...(this.resolver === undefined ? {} : { resolver: this.resolver }),
            ...(this.selectors === undefined ? {} : { selectors: this.selectors }),
            now: new Date(at),
          });
    const view = { auth, sendCeiling: HOST_MAIL_CEILING };
    this.cached = { at, view };
    return view;
  }
}

/**
 * `GET /v1/platform/email-deliverability` — "Email: SPF ✓ DKIM ✓ DMARC ✓ (checked 1 h ago)" for
 * the Connected-services card. Platform admin read (`platform.orgs.view`, the same permission as
 * the integrations read). Verdicts and short notes only; the raw records stay in DNS.
 */
@Controller('v1/platform')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class EmailDeliverabilityController {
  constructor(
    @Inject(EMAIL_DELIVERABILITY_READER) private readonly reader: EmailDeliverabilityReader,
  ) {}

  @Get('email-deliverability')
  @RequirePlatformPermission('platform.orgs.view')
  read(): Promise<EmailDeliverabilityView> {
    return this.reader.read();
  }
}
