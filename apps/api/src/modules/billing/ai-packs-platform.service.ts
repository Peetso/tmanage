import { uuidv7 } from '@tmanage/domain';
import {
  createServiceContext,
  type TenantContext,
  type TenantDatabase,
} from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { MICRO_USD_PER_CREDIT } from '../copilot/ai-cost.js';
import { platformCapMicroUsd } from '../copilot/ai-tiers.js';
import { optionalReason, requireReason } from '../platform-admin/platform-admin.access.js';
import type { PlatformRequestContext } from '../platform-admin/platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { insertPlatformAudit, platformAuditFor } from '../platform-admin/platform-audit.service.js';
import { packExpiresAt } from './ai-packs.js';
import { AI_PACKS_PLATFORM_TABLES, AiPacksRepository } from './ai-packs.repository.js';
import type { AiPoolClass } from './ai-packs.repository.js';

/**
 * 62-07 (plan 62 §5, J1). The platform admin's side of the AI test list and the credit packs:
 *
 * - the test list (the first gate before any AI spend): put a workspace on or off it and choose
 *   the pool it draws from (`customers`, or `testing` for internal and test workspaces);
 * - grant a credit pack (testing: the owner requests, a platform admin grants), optionally against
 *   the workspace's open request, or decline that request.
 *
 * Every change is one tenant transaction bound to the named workspace (a service context, the
 * PA-07 organization-write shape) that also writes the platform audit row (DA-11), with the reason
 * the admin typed. The two lists are the only cross-tenant reads, on a declared bootstrap runner.
 * Pack sizes are the admin's to type; the only bound is what the whole platform cap pays for (a
 * typo guard). Nothing here is a price, and nothing here charges anyone.
 */

/** Rows the platform table shows at most (the test group is "up to 20 workspaces", plan 62 Q5). */
export const AI_TEST_LIST_MAX = 500;

export const AI_PACKS_PLATFORM_REASON =
  'platform AI test list: listing listed workspaces and open credit-pack requests (ids, names, times only)';

/** `GET /v1/platform/ai/test-list` — CONTRACT: none on the web yet (62-19 builds the screen). */
export interface AiTestListView {
  readonly workspaces: readonly AiTestListEntryView[];
  readonly openRequests: readonly AiPackRequestQueueView[];
  /** The largest pack a grant may carry, in credits. */
  readonly maxPackCredits: number;
}

export interface AiTestListEntryView {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly listedAt: string | null;
  readonly poolClass: AiPoolClass;
}

export interface AiPackRequestQueueView {
  readonly id: string;
  readonly organizationId: string;
  readonly requestedAt: string;
}

export interface AiPackGrantView {
  readonly packId: string;
  readonly organizationId: string;
  readonly sizeCredits: number;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly requestId: string | null;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'Check the values and try again.', [
    { field, message },
  ]);
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'Not found');
}

export function parseId(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !ID.test(raw)) throw invalid(field, 'an id');
  return raw.toLowerCase();
}

export function parsePoolClass(raw: unknown): AiPoolClass | null {
  if (raw === undefined || raw === null) return null;
  if (raw === 'customers' || raw === 'testing') return raw;
  throw invalid('poolClass', 'customers or testing');
}

/** Whole credits from 1 to `max`. */
export function parsePackCredits(raw: unknown, max: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > max) {
    throw invalid('sizeCredits', `a whole number from 1 to ${max}`);
  }
  return raw;
}

function bodyOf(body: unknown): Readonly<Record<string, unknown>> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Readonly<Record<string, unknown>>)
    : {};
}

export interface AiPacksPlatformDeps {
  readonly database: Pick<TenantDatabase, 'transaction' | 'bootstrapRead'>;
  readonly repository?: AiPacksRepository;
  /** The platform cap in micro-USD (`AI_PLATFORM_CAP_MAX_USD`): bounds a pack's size. */
  readonly platformCapMicroUsd?: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export class AiPacksPlatformService {
  private readonly database: Pick<TenantDatabase, 'transaction' | 'bootstrapRead'>;
  private readonly repository: AiPacksRepository;
  private readonly maxPackCredits: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: AiPacksPlatformDeps) {
    this.database = deps.database;
    this.repository = deps.repository ?? new AiPacksRepository();
    const cap = deps.platformCapMicroUsd ?? platformCapMicroUsd(process.env);
    this.maxPackCredits = Math.max(1, Math.floor(cap / MICRO_USD_PER_CREDIT));
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? uuidv7;
  }

  private contextFor(organizationId: string, request: PlatformRequestContext): TenantContext {
    return createServiceContext({
      organizationId,
      correlationId: request.correlationId,
      policyVersion: 'platform-admin',
    });
  }

  async testList(request: PlatformRequestContext): Promise<AiTestListView> {
    const { listed, open } = await this.database.bootstrapRead(
      {
        correlationId: request.correlationId,
        reason: AI_PACKS_PLATFORM_REASON,
        tables: [...AI_PACKS_PLATFORM_TABLES],
      },
      async (db) => ({
        listed: await this.repository.testList(db, AI_TEST_LIST_MAX),
        open: await this.repository.openRequests(db, AI_TEST_LIST_MAX),
      }),
    );
    return {
      workspaces: listed.map((row) => ({
        organizationId: row.organizationId,
        name: row.name,
        slug: row.slug,
        listedAt: row.testListAt.toISOString(),
        poolClass: row.poolClass,
      })),
      openRequests: open.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        requestedAt: row.requestedAt.toISOString(),
      })),
      maxPackCredits: this.maxPackCredits,
    };
  }

  /** `{ onTestList: boolean, poolClass?: 'customers' | 'testing', reason }`. */
  async setEntry(
    actor: PlatformAdminActor,
    organizationIdRaw: unknown,
    rawBody: unknown,
    request: PlatformRequestContext,
  ): Promise<AiTestListEntryView> {
    const organizationId = parseId(organizationIdRaw, 'organizationId');
    const body = bodyOf(rawBody);
    const onTestList = body['onTestList'];
    if (typeof onTestList !== 'boolean') throw invalid('onTestList', 'true or false');
    const poolClass = parsePoolClass(body['poolClass']);
    const reason = requireReason(body['reason']);
    const context = this.contextFor(organizationId, request);
    const now = this.now();
    return this.database.transaction(context, async (tx) => {
      const organization = await this.repository.organization(tx, context);
      if (organization === null) throw notFound();
      const before = await this.repository.settings(tx, context);
      const after = {
        testListAt: onTestList ? (before.testListAt ?? now) : null,
        poolClass: poolClass ?? before.poolClass,
      };
      await this.repository.writePlatformSettings(tx, context, {
        id: this.newId(),
        ...after,
        now,
      });
      const action =
        before.onTestList !== onTestList
          ? onTestList
            ? 'platform.ai_test_list_added'
            : 'platform.ai_test_list_removed'
          : 'platform.ai_pool_class_changed';
      await insertPlatformAudit(
        tx,
        platformAuditFor(actor, request, {
          action,
          targetType: 'organization',
          targetId: organizationId,
          targetLabel: organization.name,
          organizationId,
          reason,
          beforeJson: JSON.stringify({
            onTestList: before.onTestList,
            poolClass: before.poolClass,
          }),
          afterJson: JSON.stringify({ onTestList, poolClass: after.poolClass }),
        }),
      );
      return {
        organizationId,
        name: organization.name,
        slug: organization.slug,
        listedAt: after.testListAt?.toISOString() ?? null,
        poolClass: after.poolClass,
      };
    });
  }

  /** `{ sizeCredits, requestId?, reason }`. The workspace must be on the test list (409 if not). */
  async grantPack(
    actor: PlatformAdminActor,
    organizationIdRaw: unknown,
    rawBody: unknown,
    request: PlatformRequestContext,
  ): Promise<AiPackGrantView> {
    const organizationId = parseId(organizationIdRaw, 'organizationId');
    const body = bodyOf(rawBody);
    const sizeCredits = parsePackCredits(body['sizeCredits'], this.maxPackCredits);
    const requestId =
      body['requestId'] === undefined || body['requestId'] === null
        ? null
        : parseId(body['requestId'], 'requestId');
    const reason = requireReason(body['reason']);
    const context = this.contextFor(organizationId, request);
    const now = this.now();
    const packId = this.newId();
    const expiresAt = packExpiresAt(now);
    return this.database.transaction(context, async (tx) => {
      const organization = await this.repository.organization(tx, context);
      if (organization === null) throw notFound();
      if (!(await this.repository.settings(tx, context)).onTestList) throw notOnTestList();
      let requestedBy: string | null = null;
      if (requestId !== null) {
        const open = await this.repository.lockRequest(tx, context, requestId);
        if (open === null) throw notFound();
        if (open.status !== 'open') throw requestDecided();
        requestedBy = open.requestedByMembershipId;
      }
      await this.repository.insertPack(tx, context, {
        id: packId,
        sizeCredits,
        requestedByMembershipId: requestedBy,
        grantedByUserId: actor.account.userId,
        grantedAt: now,
        expiresAt,
      });
      if (requestId !== null) {
        const decided = await this.repository.decideRequest(tx, context, {
          requestId,
          status: 'granted',
          packId,
          decidedByUserId: actor.account.userId,
          now,
        });
        if (!decided) throw requestDecided();
      }
      await insertPlatformAudit(
        tx,
        platformAuditFor(actor, request, {
          action: 'platform.ai_pack_granted',
          targetType: 'organization',
          targetId: organizationId,
          targetLabel: organization.name,
          organizationId,
          reason,
          beforeJson: null,
          afterJson: JSON.stringify({
            packId,
            sizeCredits,
            expiresAt: expiresAt.toISOString(),
            requestId,
          }),
        }),
      );
      return {
        packId,
        organizationId,
        sizeCredits,
        grantedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        requestId,
      };
    });
  }

  /** `{ reason? }`. Declines the workspace's open request. */
  async declineRequest(
    actor: PlatformAdminActor,
    organizationIdRaw: unknown,
    requestIdRaw: unknown,
    rawBody: unknown,
    request: PlatformRequestContext,
  ): Promise<AiPackRequestQueueView> {
    const organizationId = parseId(organizationIdRaw, 'organizationId');
    const requestId = parseId(requestIdRaw, 'requestId');
    const reason = optionalReason(bodyOf(rawBody)['reason']);
    const context = this.contextFor(organizationId, request);
    const now = this.now();
    return this.database.transaction(context, async (tx) => {
      const organization = await this.repository.organization(tx, context);
      if (organization === null) throw notFound();
      const open = await this.repository.lockRequest(tx, context, requestId);
      if (open === null) throw notFound();
      const decided = await this.repository.decideRequest(tx, context, {
        requestId,
        status: 'declined',
        packId: null,
        decidedByUserId: actor.account.userId,
        now,
      });
      if (!decided) throw requestDecided();
      await insertPlatformAudit(
        tx,
        platformAuditFor(actor, request, {
          action: 'platform.ai_pack_request_declined',
          targetType: 'organization',
          targetId: organizationId,
          targetLabel: organization.name,
          organizationId,
          reason,
          beforeJson: JSON.stringify({ requestId, status: 'open' }),
          afterJson: JSON.stringify({ requestId, status: 'declined' }),
        }),
      );
      return { id: requestId, organizationId, requestedAt: open.requestedAt.toISOString() };
    });
  }
}

function notOnTestList(): ApiError {
  return new ApiError(
    409,
    'conflict',
    'Put this workspace on the AI test list first.',
    undefined,
    'ai_not_on_test_list',
  );
}

function requestDecided(): ApiError {
  return new ApiError(
    409,
    'conflict',
    'This request has already been answered.',
    undefined,
    'ai_pack_request_decided',
  );
}
