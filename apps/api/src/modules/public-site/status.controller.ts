import { Controller, Get, Inject } from '@nestjs/common';
import { uuidv7 } from '@tmanage/domain';
import { Public } from '../../common/http/decorators.js';
import { TENANT_DATABASE, PUBLIC_SITE_STATUS_REPOSITORY } from '../../common/http/tokens.js';
import { INCIDENT_STATUSES } from '../../common/database/schema.js';
import type { IncidentRow } from '../../common/database/schema.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { StatusRepository } from './status.repository.js';

/**
 * Public & trust site (x159) — the status page's read.
 *
 * `GET /v1/public/site/status` is the one genuinely public read in the application: `@Public()`, so
 * it runs before the session/CSRF/tenant/capability pipeline and asks for no capability and no
 * `authorize()`. There is nothing to authorize — a status page is meant to be read by anyone,
 * including a person who is not signed in and belongs to no organization.
 *
 * `incidents` is GLOBAL (0060), so the read runs on the identity path (`identityRead`), which the
 * table's `NON_TENANT_TABLES` entry permits. Two boundaries hold the public-visibility line:
 *
 *   1. **Published-only.** The repository's SQL filters `published = 1`, and {@link toPublicStatus}
 *      re-applies the same filter before mapping — a draft incident can never reach the response,
 *      even if a future caller reaches this controller by another path.
 *   2. **Bounded and deterministic.** At most {@link MAX_INCIDENTS} incidents, newest first by
 *      `startedAt`, so the page cannot grow without bound and the order never depends on insertion.
 */

/** One published incident, as the public page reads it. Never carries a draft or the `published` flag. */
export interface PublicIncidentView {
  readonly id: string;
  readonly component: string;
  readonly status: (typeof INCIDENT_STATUSES)[number];
  readonly title: string;
  readonly body: string;
  readonly startedAt: string;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

/** The status page's response: an overall banner state and the recent published incidents. */
export interface PublicStatusView {
  /** `operational` when no published incident is unresolved; otherwise the newest active status. */
  readonly overall: 'operational' | 'investigating' | 'identified' | 'monitoring';
  readonly incidents: readonly PublicIncidentView[];
  /** When this snapshot was computed, ISO-8601. */
  readonly asOf: string;
}

/** The bounded page size. A status page shows the recent tail, not an unbounded history. */
export const MAX_INCIDENTS = 50;

@Controller('v1/public/site')
export class PublicSiteStatusController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(PUBLIC_SITE_STATUS_REPOSITORY) private readonly repository: StatusRepository,
  ) {}

  @Get('status')
  @Public()
  async status(): Promise<PublicStatusView> {
    const rows = await this.database.identityRead(
      { correlationId: uuidv7(), tables: ['incidents'] },
      (runner) => this.repository.listPublishedIncidents(runner, MAX_INCIDENTS),
    );
    return toPublicStatus(rows);
  }
}

/**
 * Map incident rows to the public snapshot — published-only, newest-first, bounded — as pure logic
 * so the behaviour is provable without a database. Re-applies every boundary the SQL already sets:
 * a draft that reaches here is still dropped, the order is pinned to `startedAt` desc, and the page
 * is capped at {@link MAX_INCIDENTS}.
 */
export function toPublicStatus(rows: readonly IncidentRow[]): PublicStatusView {
  const published = rows
    .filter((row) => row.published)
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, MAX_INCIDENTS);

  const newestActive = published.find((row) => row.status !== 'resolved');

  return {
    overall: newestActive === undefined ? 'operational' : activeOverall(newestActive.status),
    incidents: published.map(toIncidentView),
    asOf: new Date().toISOString(),
  };
}

/** Narrow an incident status to the active subset the overall banner can hold (never `resolved`). */
function activeOverall(
  status: PublicIncidentView['status'],
): Exclude<PublicStatusView['overall'], 'operational'> {
  return status === 'resolved' ? 'monitoring' : status;
}

function toIncidentView(row: IncidentRow): PublicIncidentView {
  return {
    id: row.id,
    component: row.component,
    status: row.status,
    title: row.title,
    body: row.body,
    startedAt: row.startedAt.toISOString(),
    resolvedAt: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
