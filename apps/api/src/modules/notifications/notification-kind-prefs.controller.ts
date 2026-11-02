import { Body, Controller, Get, HttpCode, Inject, Optional, Param, Put } from '@nestjs/common';
import { isRequiredActionKind, kindDeliveryFor, notificationDefaultsFor } from '@tmanage/domain';
import type { NotificationProfile, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import { NOTIFICATION_KINDS } from '../../common/database/schema.js';
import type { NotificationKind } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { NotificationKindPrefsRepository } from './notification-kind-prefs.repository.js';

/**
 * Per-kind notification opt-out (x152) — the finer sibling of NOTIF-001's coarse
 * `notification-preferences` controller. A member turns one *kind* of notification on or off; the two
 * routes list the acting member's per-kind settings and set one.
 *
 * ## Own settings only, and the reused capability
 *
 * There is no membership in the path: the seat is the authenticated `context.membershipId`, so no
 * caller can read or change another person's opt-outs — the request has no way to name one. The
 * capability is **`work.read`**, the same choice and for the same reason the coarse controller
 * recorded: `12-PERMISSION-MATRIX` names no notification capability, `work.read` is the one every
 * internal role holds and no client role does, and adding a `notification.write` would put a word in
 * the ceiling table the matrix does not have (this slice adds no `capabilities.ts` entry). A caller
 * without `work.read` (a client principal) is refused 403 by `CapabilityGuard` before any handler.
 *
 * ## The view fills defaults; a kind with no row is enabled
 *
 * A person who has opted out of nothing has no rows, and {@link NotificationKindPrefView} still lists
 * every kind — the unset ones as `enabled: true`, the "absence is the default" the coarse pref takes.
 * So "never set" and "set to enabled" answer identically, and the screen renders one toggle per kind
 * whether or not a row exists.
 *
 * ## PUT is one kind; the response is the whole set
 *
 * `PUT .../kinds/:kind` upserts exactly the named kind (a kind outside the closed enum is a 400 before
 * any write, the Known trap), and returns the full view so a client re-renders every toggle from one
 * response — the same shape the Home pins routes return their whole list after a single write.
 */
export interface NotificationKindPrefView {
  readonly kinds: readonly {
    readonly kind: NotificationKind;
    readonly enabled: boolean;
    /** 55-18: how this kind reaches the member under the org profile — now, or in the digest. */
    readonly delivery: 'immediate' | 'digest';
  }[];
}

/**
 * 55-18 (R18-d) — an unset kind's default under the org profile. Every kind the profile names
 * (immediately or through the digest) is on, and a required-action kind (client request, mention,
 * work item) is on whatever the profile; a digested kind is still delivered, only batched.
 */
export function kindEnabledByDefault(
  profile: NotificationProfile,
  kind: NotificationKind,
): boolean {
  if (isRequiredActionKind(kind)) return true;
  const defaults = notificationDefaultsFor(profile);
  return [...defaults.immediateKinds, ...defaults.digestKinds].some((k) => k === kind);
}

/** The set-a-kind body — `enabled` arrives as `unknown` and is validated in the route. */
interface SetKindBody {
  readonly enabled?: unknown;
}

function isNotificationKind(value: string): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

@Controller('v1/organizations/:orgSlug/notification-preferences/kinds')
export class NotificationKindPrefsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(NotificationKindPrefsRepository)
    private readonly prefs: NotificationKindPrefsRepository = new NotificationKindPrefsRepository(),
  ) {}

  /** List the acting membership's per-kind settings, every kind present, unset ones defaulted (200). */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
  ): Promise<NotificationKindPrefView> {
    return this.listOwn(context);
  }

  /**
   * Set one kind on or off for the acting membership, and return the whole set (200). `:kind` outside
   * the closed enum is a 400 with no write (Known trap); a non-boolean `enabled` is a 400.
   */
  @Put(':kind')
  @RequireCapability('work.read')
  @HttpCode(200)
  async set(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Param('kind') kindParam: string,
    @Body() body: SetKindBody,
  ): Promise<NotificationKindPrefView> {
    const details: { field: string; message: string }[] = [];
    if (!isNotificationKind(kindParam)) {
      details.push({ field: 'kind', message: `must be one of ${NOTIFICATION_KINDS.join(', ')}` });
    }
    if (typeof body?.enabled !== 'boolean') {
      details.push({ field: 'enabled', message: 'must be a boolean' });
    }
    if (
      details.length > 0 ||
      !isNotificationKind(kindParam) ||
      typeof body?.enabled !== 'boolean'
    ) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', details);
    }

    const kind = kindParam;
    const enabled = body.enabled;
    // Own-membership write: the seat is the acting context's, never a value the request could name.
    await this.database.transaction(context, (tx) =>
      this.prefs.upsert(tx, context, context.membershipId, kind, enabled),
    );
    return this.listOwn(context);
  }

  /** The acting membership's per-kind view: every kind, its stored `enabled` or the default (true). */
  private async listOwn(context: TenantContext): Promise<NotificationKindPrefView> {
    const { rows, profile } = await this.database.read(context, async (runner) => ({
      rows: await this.prefs.listForMembership(runner, context, context.membershipId),
      profile: await this.prefs.findNotificationProfile(runner, context),
    }));
    const byKind = new Map(rows.map((row) => [row.kind, row.enabled]));
    return {
      kinds: NOTIFICATION_KINDS.map((kind) => ({
        kind,
        enabled: byKind.get(kind) ?? kindEnabledByDefault(profile, kind),
        delivery: kindDeliveryFor(profile, kind),
      })),
    };
  }
}
