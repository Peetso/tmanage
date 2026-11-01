import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { OrgIpAllowlistRow } from '../../common/database/schema.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { canonicaliseEntry } from './cidr.js';
import { AdminIpAllowlistRepository } from './ip-allowlist.repository.js';
import type { AuditService } from '../audit/audit.service.js';

/**
 * Organization IP allowlist — Administration module 18 (x277). The service half: list the org's
 * advisory allowed IP/CIDR ranges, add one, and remove one. The controller
 * (`ip-allowlist.controller.ts`) is thin; this file owns the authorization, validation and the
 * tenant-scoped data access.
 *
 * ## Advisory record only — no request-time enforcement in this slice
 *
 * This surface **records** ranges a security admin trusts; it does not refuse a request by source IP.
 * Enforcement in the request path is a later slice, deliberately separate so recording ranges cannot
 * lock an administrator out while they are still entering them. What this slice guarantees is that a
 * stored range is *well-formed*: every `cidr` is a valid IPv4/IPv6 address or CIDR block (`cidr.ts`),
 * or the write is refused whole with a 400 — nothing malformed is ever stored.
 *
 * ## Distinct from the security-settings blob (x176)
 *
 * `security_settings` (x176) carries one posture row per org whose `ip_allowlist_json` column holds an
 * array on one blob. This is a separate, itemised entry table (`org_ip_allowlist`, 0146): each range is
 * its own row with an optional label, listed/added/removed on the security screen.
 *
 * ## `org.security.manage`, and the order that matters
 *
 * Every route is behind `org.security.manage` — the security-admin gate the audit named for this
 * surface (owners and org admins hold it). The route guard asks the coarse question (UX/defence), and
 * this service authorizes it again as the authoritative decision (`25-AUTH-AND-TENANT-ISOLATION` §3:
 * route guards are UX only, the API authorizes every action). No `capabilities.ts` edit — the
 * capability already exists.
 *
 * `POST` names no cross-tenant target — the only organization it can write into is
 * `context.organizationId`, resolved from an active membership before this code runs — so it
 * authorizes and validates before the single insert; a duplicate range is a 409 with no second row.
 *
 * `DELETE` names an entry id in its path. It is **resolved tenant-scoped BEFORE it authorizes** (the
 * Known trap): an entry from another studio simply does not resolve, and the answer is the same **404**
 * an absent id gives — with no write — so a cross-tenant target is indistinguishable from absent and a
 * neighbour's entry is never removed. Only once the row is in hand does the service authorize.
 */

/**
 * What a caller is allowed to see of one allowlist entry — paired Exact with the web's
 * `IpAllowlistEntryView` in `e2e/contracts/api-web-shapes.ts`. `organizationId` is deliberately absent:
 * the wire projection never echoes the tenant id.
 */
export interface IpAllowlistEntryView {
  readonly id: string;
  readonly cidr: string;
  readonly label: string | null;
  readonly createdAt: string;
}

/** The fields an add sends, once validated, canonicalised and normalised. */
export interface IpAllowlistInput {
  readonly cidr: string;
  readonly label: string | null;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
export function toView(row: OrgIpAllowlistRow): IpAllowlistEntryView {
  return {
    id: row.id,
    cidr: row.cidr,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The audit metadata for one range. A `/` is not a safe audit value, so the range is split into its
 * network address and prefix length; the free-text label is never written.
 */
function rangeMetadata(cidr: string): { range_start: string; prefix_length: number | null } {
  const [start = cidr, prefix] = cidr.split('/');
  const length = prefix === undefined ? null : Number(prefix);
  return { range_start: start, prefix_length: Number.isFinite(length) ? length : null };
}

/** The label column width (`org_ip_allowlist.label`). */
const MAX_LABEL_LENGTH = 120;

type Detail = { field: string; message: string };

/**
 * The tenant-scoped data access the service depends on. A seam, not a separate file: the real
 * implementation ({@link AdminIpAllowlistRepository}) is co-located, and the unit test supplies an
 * in-memory fake so the resolve-then-authorize order, the cross-tenant 404, the duplicate 409 and the
 * `org.security.manage` gate are proved without MySQL (Peter's rule: no DB tests in-slice). Every
 * method takes the {@link TenantContext}; no `organizationId` is ever taken from a DTO.
 */
export interface IpAllowlistStore {
  listAll(runner: TenantQueryRunner, context: TenantContext): Promise<readonly OrgIpAllowlistRow[]>;
  findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    entryId: string,
  ): Promise<OrgIpAllowlistRow | null>;
  findByCidr(
    runner: TenantQueryRunner,
    context: TenantContext,
    cidr: string,
  ): Promise<OrgIpAllowlistRow | null>;
  insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: IpAllowlistInput,
  ): Promise<OrgIpAllowlistRow>;
  remove(runner: TenantQueryRunner, context: TenantContext, entryId: string): Promise<void>;
}

export class AdminIpAllowlistService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly store: IpAllowlistStore = new AdminIpAllowlistRepository(),
    // 2026-10-31 live test: adding or removing a range left no audit row. Optional so the unit
    // tests can build the service without one; the module always wires the global audit service.
    private readonly audit?: Pick<AuditService, 'record'>,
  ) {}

  /** The tenant's allowlist entries, oldest first. Behind `org.security.manage`. */
  async list(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly IpAllowlistEntryView[]> {
    this.requireSecurityManage(principal, context, 'ip_allowlist.list');
    const rows = await this.database.read(context, (runner) => this.store.listAll(runner, context));
    return rows.map(toView);
  }

  /**
   * Add an allowlist entry. Authorizes `org.security.manage` (403) and validates the body (400, no
   * write) before the single insert; a malformed `cidr` is refused with no write, and a range already
   * present for the organization is a 409 (no second row).
   */
  async add(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<IpAllowlistEntryView> {
    this.requireSecurityManage(principal, context, 'ip_allowlist.add');
    const input = validateBody(body);

    const row = await this.database.transaction(context, async (tx) => {
      const existing = await this.store.findByCidr(tx, context, input.cidr);
      if (existing) {
        throw new ApiError(
          409,
          'conflict',
          'That IP range is already on the allowlist.',
          undefined,
          'ip_allowlist.duplicate_cidr',
        );
      }
      const inserted = await this.store.insert(tx, context, input);
      await this.audit?.record(tx, context, {
        action: 'ip_allowlist.entry_added',
        objectId: inserted.id,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: rangeMetadata(inserted.cidr),
      });
      return inserted;
    });
    return toView(row);
  }

  /**
   * Remove an allowlist entry, tenant-scoped. Resolves the entry (**404**, no write) BEFORE it
   * authorizes (`org.security.manage`, 403). An absent or cross-tenant id is the same 404, so nothing
   * is deleted that the caller could not see (the Known trap). On success the route answers 204.
   */
  async remove(context: TenantContext, principal: Principal, entryId: string): Promise<void> {
    if (typeof entryId !== 'string' || entryId === '') {
      throw new ApiError(400, 'validation_failed', 'entryId is required', [
        { field: 'entryId', message: 'must be a non-empty string' },
      ]);
    }
    await this.database.transaction(context, async (tx) => {
      // 1. Resolve tenant-scoped, BEFORE authorize (Known trap): unknown/cross-tenant → 404, no write.
      const entry = await this.store.findById(tx, context, entryId);
      if (!entry) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'ip_allowlist.not_visible',
        );
      }
      // 2. The real org-wide authorize; a denial is a 403, never revealing the entry existed.
      this.requireSecurityManage(principal, context, 'ip_allowlist.remove');
      // 3. Delete, tenant-scoped. Idempotent at the storage layer (a scoped DELETE).
      await this.store.remove(tx, context, entryId);
      await this.audit?.record(tx, context, {
        action: 'ip_allowlist.entry_removed',
        objectId: entry.id,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: rangeMetadata(entry.cidr),
      });
    });
  }

  /** Authorize an org-scoped `org.security.manage` (projectId null), or throw 403. */
  private requireSecurityManage(
    principal: Principal,
    context: TenantContext,
    action: string,
  ): void {
    const verdict = authorize({
      principal,
      capability: 'org.security.manage',
      resource: {
        organizationId: context.organizationId,
        // Null: an org-level resource (security config), no project relation to lean on.
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:${verdict.code}`,
      );
    }
  }
}

interface AddEntryBody {
  readonly cidr?: unknown;
  readonly label?: unknown;
}

/**
 * Validate and normalise the whole body, or throw a 400 that names every offending field at once.
 * `cidr` is required and must parse as a valid IPv4/IPv6 address or CIDR block (`cidr.ts`, reused from
 * the x176 helper) — its canonical form is stored. `label` is optional (absent, null or empty clears
 * it), bounded at {@link MAX_LABEL_LENGTH}. Returns the persisted-ready input only when nothing is wrong.
 */
function validateBody(raw: unknown): IpAllowlistInput {
  const body = (raw ?? {}) as AddEntryBody;
  const details: Detail[] = [];

  let cidr: string | null = null;
  if (typeof body.cidr !== 'string' || body.cidr.trim() === '') {
    details.push({ field: 'cidr', message: 'must be a non-empty string' });
  } else {
    const canonical = canonicaliseEntry(body.cidr.trim());
    if (canonical === null) {
      details.push({ field: 'cidr', message: 'must be a valid IP address or CIDR range' });
    } else {
      cidr = canonical;
    }
  }

  const label = optionalLabel(body.label, details);

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return { cidr: cidr as string, label: label ?? null };
}

/** An optional label: absent/null/empty is null; otherwise a bounded, trimmed string. */
function optionalLabel(raw: unknown, details: Detail[]): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    details.push({ field: 'label', message: 'must be a string or null' });
    return undefined;
  }
  const value = raw.trim();
  if (value === '') return null;
  if (value.length > MAX_LABEL_LENGTH) {
    details.push({ field: 'label', message: `must be ${MAX_LABEL_LENGTH} characters or fewer` });
    return undefined;
  }
  return value;
}
