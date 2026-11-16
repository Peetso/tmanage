import {
  authorize,
  parsePublicLinkExpiry,
  parsePublicLinkIds,
  parsePublicLinkManagerQuery,
  PUBLIC_LINK_ENDING_SOON_DAYS,
  PUBLIC_LINK_MANAGER_PAGE_SIZE,
  publicLinkManagedStatus,
} from '@tmanage/domain';
import type { PublicLinkManagedStatus, PublicLinkParse, Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PublicLinkKind, PublicLinkTargets } from './public-link-targets.js';
import { PublicLinkManagerRepository } from './public-link-manager.repository.js';
import type { ManagedLinkFilter, ManagedLinkRow } from './public-link-manager.repository.js';
import type { PublicLinksService } from './public-links.service.js';

/**
 * 56-07p — Settings · Public links: one place where an owner or admin sees every link the
 * workspace has issued that opens without signing in, and revokes one, many, or moves their end.
 *
 * - Every call needs `org.security.manage` (owner and admin), checked here against the principal
 *   the session resolved — never a role, id or flag from the request — on top of the route guard.
 * - Only the kinds this workspace really issues are listed and changed: the kinds a registered
 *   target adapter takes (approval, quote). `magic_signin` (portal sign-in's own 15-minute,
 *   single-use link) is never listed and never touched here.
 * - Revoking is the existing revoke path ({@link PublicLinksService.revokeInTransaction}), so a
 *   revoked link answers `revoked` from the next request on. An end-date change is one audited
 *   update per link; an ended link keeps its end.
 * - The list carries metadata only: no token, no token hint, no code.
 */

/** One link as the manager screen shows it. Paired Exact with the web in the contracts gate. */
export interface ManagedPublicLinkView {
  readonly id: string;
  readonly kind: PublicLinkKind;
  /** Where "Open what it shows" goes: the deliverable (with its project) or the quote. */
  readonly opens:
    | { readonly projectId: string; readonly deliverableId: string }
    | {
        readonly quoteId: string;
      }
    | null;
  /** What the link opens (the deliverable's or the quote's title); null when it is gone. */
  readonly title: string | null;
  /** "3" for a deliverable version, the quote number for a quote; null when unknown. */
  readonly reference: string | null;
  readonly audienceEmail: string | null;
  readonly createdByUserId: string | null;
  readonly createdByName: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastOpenedAt: string | null;
  readonly openCount: number;
  readonly status: PublicLinkManagedStatus;
  readonly revokedAt: string | null;
  readonly revokedByName: string | null;
}

/** `GET …/public-links/manage`. Paired Exact with the web in the contracts gate. */
export interface PublicLinkManagerView {
  readonly links: readonly ManagedPublicLinkView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly counts: {
    readonly active: number;
    readonly endingSoon: number;
    readonly ended: number;
  };
  readonly kinds: readonly PublicLinkKind[];
  readonly creators: readonly { readonly id: string; readonly name: string }[];
}

/** A bulk revoke or end-date change: how many links changed, how many were skipped (not live). */
export interface PublicLinkBulkResultView {
  readonly changed: number;
  readonly skipped: number;
}

export type PublicLinkManagerStore = Pick<
  PublicLinkManagerRepository,
  'page' | 'counts' | 'creators' | 'setExpiry'
>;

export interface PublicLinkManagerServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly targets: Pick<PublicLinkTargets, 'issuedKinds'>;
  readonly links: Pick<PublicLinksService, 'revokeInTransaction' | 'findForUpdate'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly store?: PublicLinkManagerStore;
  readonly now?: () => Date;
}

const DAY_MS = 86_400_000;

export class PublicLinkManagerService {
  private readonly store: PublicLinkManagerStore;
  private readonly now: () => Date;

  constructor(private readonly options: PublicLinkManagerServiceOptions) {
    this.store = options.store ?? new PublicLinkManagerRepository();
    this.now = options.now ?? (() => new Date());
  }

  async list(
    context: TenantContext,
    principal: Principal,
    raw: Readonly<Record<string, unknown>>,
  ): Promise<PublicLinkManagerView> {
    requireManager(principal, context);
    const kinds = this.options.targets.issuedKinds();
    const query = unwrap(parsePublicLinkManagerQuery(raw, kinds));
    const now = this.now();
    const pageSize = PUBLIC_LINK_MANAGER_PAGE_SIZE;
    if (kinds.length === 0) {
      return {
        links: [],
        total: 0,
        page: query.page,
        pageSize,
        counts: { active: 0, endingSoon: 0, ended: 0 },
        kinds,
        creators: [],
      };
    }
    const filter: ManagedLinkFilter = {
      kinds,
      kind: query.kind,
      createdBy: query.createdBy,
      search: query.search,
      state: query.state,
      now,
      endingBefore: new Date(now.getTime() + PUBLIC_LINK_ENDING_SOON_DAYS * DAY_MS),
    };
    return this.options.database.read(context, async (runner) => {
      const { rows, total } = await this.store.page(runner, context, filter, query.page, pageSize);
      return {
        links: rows.map((row) => toManagedView(row, now)),
        total,
        page: query.page,
        pageSize,
        counts: await this.store.counts(runner, context, filter),
        kinds,
        creators: await this.store.creators(runner, context, kinds),
      };
    });
  }

  /** Revoke every named live link of a listed kind, in one transaction, through the revoke path. */
  async revokeMany(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<PublicLinkBulkResultView> {
    requireManager(principal, context);
    const linkIds = unwrap(parsePublicLinkIds(body));
    const kinds: readonly string[] = this.options.targets.issuedKinds();
    return this.options.database.transaction(context, async (tx) => {
      let changed = 0;
      for (const linkId of linkIds) {
        const link = await this.options.links.findForUpdate(tx, context, linkId);
        if (link === null || !kinds.includes(link.kind)) continue;
        if (await this.options.links.revokeInTransaction(tx, context, link)) changed += 1;
      }
      return { changed, skipped: linkIds.length - changed };
    });
  }

  /** Move the end of every named live link of a listed kind; each change is an audit row. */
  async changeExpiry(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<PublicLinkBulkResultView> {
    requireManager(principal, context);
    const now = this.now();
    const { linkIds, expiresAt } = unwrap(parsePublicLinkExpiry(body, now));
    const kinds = this.options.targets.issuedKinds();
    return this.options.database.transaction(context, async (tx) => {
      let changed = 0;
      for (const linkId of linkIds) {
        const link = await this.options.links.findForUpdate(tx, context, linkId);
        if (link === null) continue;
        if (!(await this.store.setExpiry(tx, context, link.id, kinds, expiresAt, now))) continue;
        await this.options.audit.record(tx, context, {
          action: 'public_link.expiry_changed',
          result: 'allowed',
          objectId: link.id,
          actorUserId: context.userId,
          metadata: {
            link_kind: link.kind,
            target_type: link.targetType,
            expires_before: link.expiresAt.toISOString(),
            expires_after: expiresAt.toISOString(),
          },
        });
        changed += 1;
      }
      return { changed, skipped: linkIds.length - changed };
    });
  }
}

/** Owner and admin: `org.security.manage`, the permission of the workspace-wide link list. */
function requireManager(principal: Principal, context: TenantContext): void {
  const decision = authorize({
    principal,
    capability: 'org.security.manage',
    resource: {
      organizationId: context.organizationId,
      projectId: null,
      audience: 'internal',
      lifecycle: 'active',
    },
  });
  if (!decision.allowed) {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'public_link.manage');
  }
}

function unwrap<T>(parsed: PublicLinkParse<T>): T {
  if (parsed.ok) return parsed.value;
  throw new ApiError(400, 'validation_failed', 'The request is invalid', [
    { field: parsed.field, message: parsed.message },
  ]);
}

export function toManagedView(row: ManagedLinkRow, now: Date): ManagedPublicLinkView {
  const status = publicLinkManagedStatus(row, now);
  return {
    id: row.id,
    kind: row.kind as PublicLinkKind,
    opens: openTarget(row),
    title: row.deliverableTitle ?? row.quoteTitle,
    reference: row.versionNo !== null ? String(row.versionNo) : (row.quoteNumber ?? null),
    audienceEmail: row.audienceEmail,
    createdByUserId: row.createdByUserId,
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
    openCount: row.uses,
    status,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByName: row.revokedByName,
  };
}

function openTarget(row: ManagedLinkRow): ManagedPublicLinkView['opens'] {
  if (row.projectId !== null && row.deliverableId !== null) {
    return { projectId: row.projectId, deliverableId: row.deliverableId };
  }
  return row.quoteId === null ? null : { quoteId: row.quoteId };
}
