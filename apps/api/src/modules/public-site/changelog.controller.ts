import { Controller, Get, Inject, Req } from '@nestjs/common';
import { Public } from '../../common/http/decorators.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { ChangelogEntryRow } from '../../common/database/schema.js';
import { CHANGELOG_REPOSITORY } from './changelog.repository.js';
import type { ChangelogRepository } from './changelog.repository.js';

/**
 * Public product changelog — Public site, module 1 (x160).
 *
 * `38-MODULE-MAP` §Public site (changelog) and the 2026-09-27 audit's rank #1 (Public site Missing —
 * no changelog). `GET /v1/public/site/changelog` returns the published product updates, newest
 * first, grouped by the month they went live.
 *
 * ## Public, by construction — no session, no tenant, no capability
 *
 * The route is `@Public()`: `SessionAuthGuard`, `CsrfGuard`, `TenantContextGuard` and
 * `CapabilityGuard` all skip it (see `decorators.ts`). That is correct rather than convenient — a
 * changelog is marketing-site content a prospective customer reads before they have an account, so
 * there is no principal to authorize and no organization to scope to. There is therefore no
 * `authorize()` call and no `capabilities.ts` edit: the read exposes only rows an editor already
 * marked live for everyone.
 *
 * ## The table is global, so the read runs on the identity path
 *
 * `changelog_entries` (0061) carries no `organization_id` (`NON_TENANT_TABLES`, tenant-guard.ts), so
 * the read cannot go through `TenantDatabase.read`, which requires a `TenantContext`. It uses
 * `identityRead`, the same guarded, tenant-free path the identity tables use, declared over the one
 * global table it touches — a statement that strayed to a tenant table would be refused.
 *
 * ## Published-only is enforced in the repository, not trusted from the row
 *
 * The repository's `WHERE published = 1 AND published_at IS NOT NULL` is the whole of the
 * draft/publish boundary: a draft is never fetched, so it can never be grouped or returned. The
 * controller does no second filter — it groups the rows the read hands it and projects them.
 */

/** A bounded page: the public changelog is a recent list, not an unbounded archive export. */
const MAX_CHANGELOG_ENTRIES = 200;

/** The three categories an entry may carry; VARCHAR in the table, narrowed to the union on the wire. */
type ChangelogCategory = 'feature' | 'fix' | 'security';

/** One published entry on the wire. No `View` suffix — the paired shape is {@link PublicChangelogView}. */
interface PublicChangelogEntry {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  /** The entry body as Markdown source; the client renders it. */
  readonly bodyMd: string;
  readonly category: ChangelogCategory;
  /** An ISO-8601 instant on the wire — the moment the entry went live. */
  readonly publishedAt: string;
}

/** One month bucket: its `YYYY-MM` month (UTC) and the entries published in it, newest first. */
interface PublicChangelogMonth {
  readonly month: string;
  readonly entries: readonly PublicChangelogEntry[];
}

/**
 * The public changelog read's response — x160's `PublicChangelogView`, paired Exact in
 * `e2e/contracts/api-web-shapes.ts` with the web shape `ChangelogScreen` consumes (CONTRACT-001).
 * No tenant id is echoed: this content belongs to no tenant.
 */
export interface PublicChangelogView {
  readonly months: readonly PublicChangelogMonth[];
}

@Controller('v1/public/site')
export class ChangelogController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(CHANGELOG_REPOSITORY) private readonly changelog: ChangelogRepository,
  ) {}

  /**
   * The published changelog, newest first, grouped by the month each entry went live.
   *
   * Only months that carry at least one published entry are emitted, newest month first; within a
   * month the entries keep the repository's `published_at DESC` order. The read is bounded to
   * {@link MAX_CHANGELOG_ENTRIES} rows.
   */
  @Get('changelog')
  @Public()
  async list(@Req() request: RequestLike): Promise<PublicChangelogView> {
    const { correlationId } = requireRequestState(request);

    const rows = await this.database.identityRead(
      { correlationId, tables: ['changelog_entries'] },
      (runner) => this.changelog.listPublished(runner, MAX_CHANGELOG_ENTRIES),
    );

    const byMonth = new Map<string, PublicChangelogEntry[]>();
    for (const row of rows) {
      // The repository returns only published rows with a live date, so `publishedAt` is present;
      // the guard keeps a hypothetical NULL out of the grouping rather than emitting an `Invalid
      // Date` month.
      if (!row.publishedAt) continue;

      const month = row.publishedAt.toISOString().slice(0, 7);
      const bucket = byMonth.get(month) ?? [];
      bucket.push(toEntry(row));
      byMonth.set(month, bucket);
    }

    const months: PublicChangelogMonth[] = [...byMonth.keys()]
      // Newest month first — the reverse of the ascending string sort.
      .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0))
      .map((month) => ({ month, entries: byMonth.get(month) ?? [] }));

    return { months };
  }
}

/** The minimal request shape `requireRequestState` needs — its headers carry the correlation id. */
interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
}

/** An explicit projection, not a serialised row: the wire narrows `category` to its three values. */
function toEntry(row: ChangelogEntryRow): PublicChangelogEntry {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    bodyMd: row.bodyMd,
    category: narrowCategory(row.category),
    // Guarded by the caller: only rows with a live date reach here.
    publishedAt: (row.publishedAt as Date).toISOString(),
  };
}

/** Narrow the stored VARCHAR to the wire union, defaulting an unrecognised value to `feature`. */
function narrowCategory(value: string): ChangelogCategory {
  return value === 'fix' || value === 'security' ? value : 'feature';
}
