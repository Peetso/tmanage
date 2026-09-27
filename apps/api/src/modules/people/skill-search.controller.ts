import { Controller, Get, Inject, Query } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { PERSON_SKILL_SEARCH_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PERSON_SKILL_LEVELS } from '../../common/database/schema.js';
import type { MembershipRow, PersonSkillLevel } from '../../common/database/schema.js';
import type {
  PersonSkillSearchRepository,
  SkillSearchMatchRow,
} from './skill-search.repository.js';

/**
 * Skill directory search (module 14, x194). One read endpoint: find the tenant's members who
 * declare one or more skill tags (with an optional minimum level). Skills are stored by x172; this
 * slice is the matching *read* the People profile named but had not built.
 *
 * ## Authorization — two layers, read-only
 *
 * `CapabilityGuard` asks the coarse `work.read` ceiling question. This controller adds the
 * authoritative org-scoped `authorize()` (`25-AUTH` §3 step 2, deny-by-default, `projectId: null`)
 * that the guard cannot — a suspended membership fails it — exactly as the x172 skills read does.
 * There is no write on any path.
 *
 * ## Known trap — read-only, so tenant-scope and bound everything
 *
 * Every query is tenant-scoped (the repository predicates `organization_id = context` on both the
 * skill row and the joined membership). The requested labels are normalised and validated
 * (non-empty), a blank query returns an empty result rather than scanning the directory, the level
 * filter is validated against the stored skill-level set, and both the number of labels and the
 * member page size are capped so no input yields an unbounded read. A result row never echoes
 * `organizationId`.
 *
 * A distinct literal path (`…/people/skills/search`) from x172's `…/people/:membershipId/skills`, so
 * the two controllers never collide.
 */

/** Match the member page cap: at most this many distinct members are returned. */
const MAX_PAGE_SIZE = 50;
/** The default member page size when the caller names no `limit`. */
const DEFAULT_PAGE_SIZE = 25;
/** Cap the number of distinct skill tags a single query may filter on (avoids an unbounded IN). */
const MAX_LABELS = 20;

/** One directory row: a member and the requested skills they matched. `organizationId` is absent. */
export interface SkillSearchView {
  readonly membershipId: string;
  readonly role: string;
  readonly status: MembershipRow['status'];
  readonly matched: readonly { readonly label: string; readonly level: PersonSkillLevel }[];
}

/** Normalise a submitted label the same way x172 stores it: trim and collapse runs of whitespace. */
function normaliseLabel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ');
}

function isLevel(value: unknown): value is PersonSkillLevel {
  return typeof value === 'string' && (PERSON_SKILL_LEVELS as readonly string[]).includes(value);
}

/** Collapse the `skill` query parameter (absent, one value, or repeated) into an array of strings. */
function toRawLabels(skill: string | string[] | undefined): readonly string[] {
  if (skill === undefined) return [];
  return Array.isArray(skill) ? skill : [skill];
}

/**
 * Group flat (member, skill) rows — already ordered by member then label — into directory rows,
 * keeping at most `limit` distinct members. Rows arrive grouped by member, so a single pass suffices.
 */
function groupByMember(
  rows: readonly SkillSearchMatchRow[],
  limit: number,
): readonly SkillSearchView[] {
  const results: SkillSearchView[] = [];
  let current:
    (SkillSearchView & { matched: { label: string; level: PersonSkillLevel }[] }) | null = null;

  for (const row of rows) {
    if (!current || current.membershipId !== row.membershipId) {
      if (results.length >= limit) break;
      current = { membershipId: row.membershipId, role: row.role, status: row.status, matched: [] };
      results.push(current);
    }
    current.matched.push({ label: row.label, level: row.level });
  }
  return results;
}

@Controller('v1/organizations/:orgSlug/people/skills')
export class SkillSearchController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(PERSON_SKILL_SEARCH_REPOSITORY) private readonly search: PersonSkillSearchRepository,
  ) {}

  /**
   * Search the member directory by skill. `work.read`, relation-gated org-scoped (`projectId: null`,
   * so every active member may read the directory). A blank query returns an empty result — it never
   * scans the directory. A bad `level` or `limit` is 400; the member page is capped.
   */
  @Get('search')
  @RequireCapability('work.read')
  async run(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('skill') skill?: string | string[],
    @Query('level') level?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly results: readonly SkillSearchView[] }> {
    if (!this.mayReadOrg(principal, context)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'skill_search_denied');
    }

    let minLevel: PersonSkillLevel | null = null;
    if (level !== undefined) {
      if (!isLevel(level)) {
        throw new ApiError(400, 'validation_failed', 'level is invalid', [
          { field: 'level', message: `must be one of ${PERSON_SKILL_LEVELS.join(', ')}` },
        ]);
      }
      minLevel = level;
    }

    let page = DEFAULT_PAGE_SIZE;
    if (limit !== undefined) {
      const parsed = Number(limit);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new ApiError(400, 'validation_failed', 'limit is invalid', [
          { field: 'limit', message: 'must be a positive integer' },
        ]);
      }
      page = Math.min(parsed, MAX_PAGE_SIZE);
    }

    const labels = [
      ...new Set(
        toRawLabels(skill)
          .map(normaliseLabel)
          .filter((l) => l !== ''),
      ),
    ].slice(0, MAX_LABELS);
    // A blank query returns an empty result rather than the whole directory.
    if (labels.length === 0) return { results: [] };

    const rows = await this.database.read(context, (runner) =>
      this.search.searchMembersBySkill(runner, context, { labels, minLevel, limit: page }),
    );
    return { results: groupByMember(rows, page) };
  }

  /** Org-scoped deny-by-default read decision the route guard cannot make (membership status, etc.). */
  private mayReadOrg(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}
