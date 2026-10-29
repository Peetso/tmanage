import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  HOST_MAIL_CEILING,
  LOWER_LANE_SHARE,
  MAIL_LANES,
  effectiveCeiling,
  hourWindowStart,
  isMailLane,
  laneIsPaused,
  lanePausedSettingKey,
  mailboxCeilingSettingKey,
  parseCeiling,
} from '@tmanage/mail';
import type { MailLane, Mailbox } from '@tmanage/mail';
import { NoTenant } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { platformRequestContext } from '../platform-admin/platform-admin.access.js';
import type { PlatformRequestContext } from '../platform-admin/platform-admin.access.js';
import {
  CurrentPlatformAdmin,
  PlatformAdminGuard,
} from '../platform-admin/platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { platformAuditFor } from '../platform-admin/platform-audit.service.js';
import { RequirePlatformPermission } from '../platform-admin/require-platform-permission.decorator.js';
import type { MailHealthSource } from './mail-health.repository.js';

export const MAIL_HEALTH_SERVICE = Symbol.for('tmanage.MailHealthService');

export interface MailLaneHealth {
  readonly lane: MailLane;
  readonly mailbox: Mailbox;
  readonly sentThisHour: number;
  readonly hourCeiling: number;
  readonly deferred: number;
  readonly queued: number;
  readonly paused: boolean;
}

export interface MailboxHealth {
  readonly mailbox: Mailbox;
  readonly ceiling: number;
  /** Of the hour's ceiling, what `digest` + `bulk` may never use (margin + transactional share). */
  readonly reserved: number;
  readonly sentThisHour: number;
}

export interface MailHealthView {
  readonly lanes: readonly MailLaneHealth[];
  readonly mailboxes: readonly MailboxHealth[];
  readonly deferredAuth: number;
  /** security@ was in use this hour and `auth` mail still went out through noreply@. */
  readonly degraded: boolean;
}

/** Where a lane pause is stored: the platform settings writer, audited. */
export interface MailSettingWriter {
  writeSetting(
    key: string,
    value: string,
    audit: ReturnType<typeof platformAuditFor>,
  ): Promise<void>;
}

const REASON_MAX = 500;

export class MailHealthService {
  constructor(
    private readonly source: MailHealthSource,
    private readonly settings: MailSettingWriter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async health(context: PlatformRequestContext): Promise<MailHealthView> {
    const windowStart = hourWindowStart(this.now());
    const counts = await this.source.read(windowStart, context.correlationId);
    const ceilingOf = (mailbox: Mailbox): number =>
      parseCeiling(
        counts.settings.get(mailboxCeilingSettingKey(mailbox)),
        HOST_MAIL_CEILING.perHour,
      );
    const lanes = MAIL_LANES.map((lane): MailLaneHealth => {
      const mailbox: Mailbox = lane === 'auth' ? 'security' : 'noreply';
      const sentThisHour =
        (counts.sent.get(`${lane}:security`) ?? 0) + (counts.sent.get(`${lane}:noreply`) ?? 0);
      return {
        lane,
        mailbox,
        sentThisHour,
        hourCeiling: ceilingOf(mailbox),
        deferred: counts.pending.get(`${lane}:deferred`) ?? 0,
        queued: counts.pending.get(`${lane}:queued`) ?? 0,
        paused: laneIsPaused(lane, counts.settings.get(lanePausedSettingKey(lane))),
      };
    });
    const mailboxes = (['security', 'noreply'] as const).map((mailbox): MailboxHealth => {
      const ceiling = ceilingOf(mailbox);
      const usable = effectiveCeiling(ceiling);
      const lowerLimit = mailbox === 'noreply' ? Math.floor(usable * LOWER_LANE_SHARE) : usable;
      return {
        mailbox,
        ceiling,
        reserved: ceiling - lowerLimit,
        sentThisHour: counts.windows.get(mailbox) ?? 0,
      };
    });
    const securityInUse = (counts.windows.get('security') ?? 0) > 0;
    return {
      lanes,
      mailboxes,
      deferredAuth: counts.pending.get('auth:deferred') ?? 0,
      degraded: securityInUse && (counts.sent.get('auth:noreply') ?? 0) > 0,
    };
  }

  async pause(
    actor: PlatformAdminActor,
    laneParam: string,
    body: Readonly<Record<string, unknown>>,
    context: PlatformRequestContext,
  ): Promise<MailHealthView> {
    if (!isMailLane(laneParam)) {
      throw new ApiError(400, 'validation_failed', 'Choose a mail lane.', [
        { field: 'lane', message: `must be one of ${MAIL_LANES.join(', ')}` },
      ]);
    }
    if (laneParam === 'auth') {
      throw new ApiError(400, 'validation_failed', 'Sign-in and security mail cannot be paused.', [
        { field: 'lane', message: 'auth cannot be paused' },
      ]);
    }
    const paused = body['paused'] === undefined ? true : body['paused'];
    if (typeof paused !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'Choose paused or running.', [
        { field: 'paused', message: 'must be a boolean' },
      ]);
    }
    const rawReason = body['reason'];
    const reason =
      typeof rawReason === 'string' && rawReason.trim() !== ''
        ? rawReason.trim().slice(0, REASON_MAX)
        : null;
    const key = lanePausedSettingKey(laneParam);
    await this.settings.writeSetting(
      key,
      paused ? 'on' : 'off',
      platformAuditFor(actor, context, {
        action: paused ? 'platform.mail_lane_paused' : 'platform.mail_lane_resumed',
        targetType: 'setting',
        targetId: null,
        targetLabel: key,
        reason,
      }),
    );
    return this.health(context);
  }
}

/**
 * `/v1/platform/mail/…` — 56-31. The JSON the Platform → E-mail health card reads (counts only,
 * never an address) and the lane pause. Reading is an activity permission; pausing is the
 * settings permission (super admin, SPEC §3.1). `auth` can never be paused — a paused sign-in
 * lane locks every person out.
 */
@Controller('v1/platform/mail')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class MailHealthController {
  constructor(@Inject(MAIL_HEALTH_SERVICE) private readonly service: MailHealthService) {}

  @Get('health')
  @RequirePlatformPermission('platform.activity.view')
  health(@Req() request: object): Promise<MailHealthView> {
    return this.service.health(platformRequestContext(request));
  }

  @Post('lanes/:lane/pause')
  @HttpCode(200)
  @RequirePlatformPermission('platform.settings.edit')
  pause(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('lane') lane: string,
    @Body() body: Readonly<Record<string, unknown>> | undefined,
    @Req() request: object,
  ): Promise<MailHealthView> {
    return this.service.pause(actor, lane, body ?? {}, platformRequestContext(request));
  }
}
