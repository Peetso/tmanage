import { Body, Controller, Get, HttpCode, Inject, Optional, Put } from '@nestjs/common';
import {
  MATRIX_CHANNELS,
  MATRIX_KINDS,
  defaultMatrixCell,
  effectiveMatrixCell,
  hasCapability,
  kindChannelAvailable,
  kindDeliveryFor,
  typesInGroup,
} from '@tmanage/domain';
import type {
  NotificationMatrixCell,
  MatrixChannel,
  NaturalNotificationKind,
  NotificationProfile,
  Principal,
} from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { NotificationKindPrefsRepository } from './notification-kind-prefs.repository.js';
import { NotificationMatrixRepository } from './notification-matrix.repository.js';

/** One matrix row: the member's effective cells, the defaults, what is locked and what exists. */
interface NotificationMatrixRowView {
  readonly kind: NaturalNotificationKind;
  readonly inApp: boolean;
  readonly email: boolean;
  readonly digest: boolean;
  /** The company forces e-mail (and so the kind itself) on; both cells are locked. */
  readonly forcedEmail: boolean;
  readonly defaults: NotificationMatrixCell;
  /** Whether the kind has any type that can travel on the channel at all. */
  readonly available: { readonly email: boolean; readonly digest: boolean };
  /** 55-18: how an unset kind arrives under the org profile. */
  readonly delivery: 'immediate' | 'digest';
  /** How many notification types this row controls. */
  readonly typeCount: number;
}

/**
 * 53-15 — the acting member's notification matrix (rows = kinds, columns = In-app / E-mail /
 * Digest), with the org profile, the company's forced kinds and whether the caller may change them.
 */
export interface NotificationMatrixView {
  readonly profile: NotificationProfile;
  readonly rows: readonly NotificationMatrixRowView[];
  /** Account & security notices: always in-app and e-mail, never digested, not editable. */
  readonly account: { readonly typeCount: number };
  readonly forcedEmailKinds: readonly NaturalNotificationKind[];
  /** The caller holds `org.manage` and may change the forced kinds (generic settings PUT). */
  readonly canManageCompany: boolean;
}

interface SetCellBody {
  readonly kind?: unknown;
  readonly channel?: unknown;
  readonly enabled?: unknown;
}

function isKind(value: unknown): value is NaturalNotificationKind {
  return typeof value === 'string' && (MATRIX_KINDS as readonly string[]).includes(value);
}

function isChannel(value: unknown): value is MatrixChannel {
  return typeof value === 'string' && (MATRIX_CHANNELS as readonly string[]).includes(value);
}

/**
 * 53-15 — Settings → Notifications as a per-kind × per-channel matrix.
 *
 * Own settings only: no membership in the path, the seat is `context.membershipId`. `work.read` is
 * the capability, the same reasoned choice as the per-kind and coarse preference controllers (every
 * internal role, no client role). The In-app cell is the existing per-kind switch
 * (`notification_kind_prefs`), so this screen and the older one never disagree; E-mail and Digest
 * merge into the member's `user_preferences.prefs_json`. A kind the company forces is locked: turning
 * its In-app or E-mail cell off is a 409 with no write.
 */
@Controller('v1/organizations/:orgSlug/me/notification-matrix')
export class NotificationMatrixController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(NotificationMatrixRepository)
    private readonly matrix: NotificationMatrixRepository = new NotificationMatrixRepository(),
    @Optional()
    @Inject(NotificationKindPrefsRepository)
    private readonly kinds: NotificationKindPrefsRepository = new NotificationKindPrefsRepository(),
  ) {}

  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<NotificationMatrixView> {
    return this.view(context, principal);
  }

  /** Set one cell and return the whole matrix (200). */
  @Put()
  @RequireCapability('work.read')
  @HttpCode(200)
  async set(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: SetCellBody,
  ): Promise<NotificationMatrixView> {
    const kind = body?.kind;
    const channel = body?.channel;
    const enabled = body?.enabled;
    const details: { field: string; message: string }[] = [];
    if (!isKind(kind))
      details.push({ field: 'kind', message: `must be one of ${MATRIX_KINDS.join(', ')}` });
    if (!isChannel(channel)) {
      details.push({ field: 'channel', message: `must be one of ${MATRIX_CHANNELS.join(', ')}` });
    }
    if (typeof enabled !== 'boolean')
      details.push({ field: 'enabled', message: 'must be a boolean' });
    if (
      details.length > 0 ||
      !isKind(kind) ||
      !isChannel(channel) ||
      typeof enabled !== 'boolean'
    ) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', details);
    }

    await this.database.transaction(context, async (tx) => {
      const forced = await this.matrix.readForcedEmailKinds(tx, context);
      if (!enabled && channel !== 'digest' && forced.includes(kind)) {
        throw new ApiError(
          409,
          'conflict',
          'Your company keeps e-mail on for this kind of notification.',
          [{ field: 'kind', message: 'forced by the company' }],
        );
      }
      if (channel === 'in_app') {
        await this.kinds.upsert(tx, context, context.membershipId, kind, enabled);
      } else {
        await this.matrix.writeCell(tx, context, context.membershipId, kind, channel, enabled);
      }
    });
    return this.view(context, principal);
  }

  private async view(
    context: TenantContext,
    principal: Principal,
  ): Promise<NotificationMatrixView> {
    const facts = await this.database.read(context, async (runner) => ({
      kindRows: await this.kinds.listForMembership(runner, context, context.membershipId),
      profile: await this.kinds.findNotificationProfile(runner, context),
      stored: await this.matrix.readStoredMatrix(runner, context, context.membershipId),
      forced: await this.matrix.readForcedEmailKinds(runner, context),
    }));
    const enabledByKind = new Map(facts.kindRows.map((row) => [row.kind as string, row.enabled]));
    return {
      profile: facts.profile,
      rows: MATRIX_KINDS.map((kind) => {
        const forcedEmail = facts.forced.includes(kind);
        const cell = effectiveMatrixCell({
          profile: facts.profile,
          kind,
          kindEnabled: enabledByKind.get(kind),
          stored: facts.stored,
          forcedEmail,
        });
        return {
          kind,
          ...cell,
          forcedEmail,
          defaults: defaultMatrixCell(facts.profile, kind),
          available: {
            email: kindChannelAvailable(kind, 'email'),
            digest: kindChannelAvailable(kind, 'digest'),
          },
          delivery: kindDeliveryFor(facts.profile, kind),
          typeCount: typesInGroup(kind).length,
        };
      }),
      account: { typeCount: typesInGroup('account').length },
      forcedEmailKinds: facts.forced,
      canManageCompany: hasCapability(principal.role, 'org.manage'),
    };
  }
}
