import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { isNever } from '../ai-actions/registry/never.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { PLATFORM_PERMISSION_METADATA } from '../platform-admin/require-platform-permission.decorator.js';
import { MailHealthController, MailHealthService } from './mail-health.controller.js';
import type { MailHealthCounts } from './mail-health.repository.js';

const context = { correlationId: 'c-1', ip: null, userAgent: null };
const actor = {
  account: { userId: 'u-1', email: 'op@example.com' },
} as unknown as PlatformAdminActor;

function counts(): MailHealthCounts {
  return {
    pending: new Map([
      ['auth:deferred', 2],
      ['bulk:queued', 40],
    ]),
    sent: new Map([
      ['auth:noreply', 3],
      ['bulk:noreply', 10],
    ]),
    windows: new Map([
      ['security', 4],
      ['noreply', 13],
    ]),
    settings: new Map([
      ['mail_hour_ceiling_noreply', '100'],
      ['mail_lane_paused_bulk', 'on'],
    ]),
  };
}

function service() {
  const writeSetting = vi.fn(() => Promise.resolve());
  const svc = new MailHealthService(
    { read: () => Promise.resolve(counts()) },
    { writeSetting },
    () => new Date('2026-10-29T10:30:00Z'),
  );
  return { svc, writeSetting };
}

describe('56-31 platform mail health', () => {
  it('guards health with activity.view and the pause with settings.edit, both NEVER', () => {
    const permission = (method: 'health' | 'pause') =>
      new Reflector().get(
        PLATFORM_PERMISSION_METADATA,
        MailHealthController.prototype[method] as unknown as () => void,
      );
    expect(permission('health')).toBe('platform.activity.view');
    expect(permission('pause')).toBe('platform.settings.edit');
    expect(isNever('GET', '/v1/platform/mail/health')).toBe(true);
    expect(isNever('POST', '/v1/platform/mail/lanes/:lane/pause')).toBe(true);
  });

  it('reports counts only, ceilings with reservation, deferred auth and degradation', async () => {
    const view = await service().svc.health(context);
    expect(JSON.stringify(view)).not.toMatch(/@|to_hash|payload/u);
    expect(view.deferredAuth).toBe(2);
    expect(view.degraded).toBe(true);
    expect(view.mailboxes).toContainEqual({
      mailbox: 'noreply',
      ceiling: 100,
      reserved: 28,
      sentThisHour: 13,
    });
    expect(view.lanes.find((lane) => lane.lane === 'bulk')).toMatchObject({
      queued: 40,
      sentThisHour: 10,
      hourCeiling: 100,
      paused: true,
    });
  });

  it('refuses to pause auth (400) and writes nothing; pauses bulk, audited', async () => {
    const { svc, writeSetting } = service();
    await expect(svc.pause(actor, 'auth', {}, context)).rejects.toMatchObject({ status: 400 });
    await expect(svc.pause(actor, 'nope', {}, context)).rejects.toMatchObject({ status: 400 });
    expect(writeSetting).not.toHaveBeenCalled();
    await svc.pause(actor, 'bulk', { paused: true }, context);
    expect(writeSetting).toHaveBeenCalledWith(
      'mail_lane_paused_bulk',
      'on',
      expect.objectContaining({ action: 'platform.mail_lane_paused', actorUserId: 'u-1' }),
    );
  });
});
