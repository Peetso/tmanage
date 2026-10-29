import { Controller, Get, Inject, Optional, Res } from '@nestjs/common';
import { uuidv7 } from '@tmanage/domain';
import { Public } from '../../common/http/decorators.js';
import { TENANT_DATABASE, PUBLIC_SITE_STATUS_REPOSITORY } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { StatusRepository } from './status.repository.js';
import { MAX_INCIDENTS, toPublicStatus } from './status.controller.js';
import type { PublicStatusView } from './status.controller.js';

/**
 * 51-12 — `GET /v1/public/site/status/summary`, the small status answer for a free uptime
 * monitor and for the `/status` page's "Live status →" link.
 *
 * `GET /healthz/deep` is what the monitor alerts on (503 when the database, migrations or worker
 * fail). This route is the public-facing side: the overall banner state from the *published*
 * incidents, how many are unresolved, and the operator's optional external status page
 * (`STATUS_PAGE_URL` — an UptimeRobot / Better Stack public page). It carries no titles, bodies,
 * versions or counts beyond that, and is cached for {@link SUMMARY_CACHE_MS} in the process and
 * for the same time by any cache in front, so polling it cannot become database load.
 */

export const PUBLIC_STATUS_LINK = Symbol.for('tmanage.PublicStatusLink');

export const SUMMARY_CACHE_MS = 30_000;

export interface PublicStatusSummary {
  readonly overall: PublicStatusView['overall'];
  readonly activeIncidents: number;
  /** The operator's external public status page, or `null` when none is configured. */
  readonly liveStatusUrl: string | null;
  readonly asOf: string;
}

/** An `https:` URL without credentials, at most 300 characters — anything else is `null`. */
export function sanitiseStatusLink(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 300) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    return url.href;
  } catch {
    return null;
  }
}

@Controller('v1/public/site')
export class PublicStatusSummaryController {
  private cached: { at: number; summary: PublicStatusSummary } | null = null;
  private readonly link: string | null;

  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(PUBLIC_SITE_STATUS_REPOSITORY) private readonly repository: StatusRepository,
    @Optional() @Inject(PUBLIC_STATUS_LINK) link?: string | null,
  ) {
    this.link = sanitiseStatusLink(link);
  }

  @Get('status/summary')
  @Public()
  async summary(
    @Res({ passthrough: true }) reply: { header(name: string, value: string): unknown },
  ): Promise<PublicStatusSummary> {
    const now = Date.now();
    if (this.cached === null || now - this.cached.at >= SUMMARY_CACHE_MS) {
      const rows = await this.database.identityRead(
        { correlationId: uuidv7(), tables: ['incidents'] },
        (runner) => this.repository.listPublishedIncidents(runner, MAX_INCIDENTS),
      );
      const view = toPublicStatus(rows);
      this.cached = {
        at: now,
        summary: {
          overall: view.overall,
          activeIncidents: view.incidents.filter((i) => i.status !== 'resolved').length,
          liveStatusUrl: this.link,
          asOf: view.asOf,
        },
      };
    }
    reply.header('cache-control', `public, max-age=${String(SUMMARY_CACHE_MS / 1_000)}`);
    return this.cached.summary;
  }
}
