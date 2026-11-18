import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';
import { PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { PLATFORM_PERMISSION_METADATA } from '../require-platform-permission.decorator.js';
import { PlatformPersonMailController } from './person-mail.controller.js';
import type { FeatureNewsRecord, PersonMailRepository } from './person-mail.repository.js';
import { PersonMailService, parseFeatureNews } from './person-mail.service.js';

/** EMAILBUILD2 — the "Tips and reminders" switch and the "Feature news" card. */

const ctx = { correlationId: 'c', ip: null, userAgent: null };
const actor: PlatformAdminActor = {
  account: {
    userId: 'u',
    email: 'admin@tmanageapp.com',
    displayName: 'Admin',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 's',
  stepUp: null,
};
const NOTE_ID = '0199aa00-0000-7000-8000-0000000000e1';
const body = {
  titleEn: 'Boards',
  titleAr: 'اللوحات',
  bodyEn: 'See every task as a card and drag it between columns.',
  bodyAr: 'شاهد كل مهمة كبطاقة واسحبها بين الأعمدة.',
  link: '/work',
};

function harness(sentAt: Date | null = null, sendWins = true) {
  const note: FeatureNewsRecord = {
    id: NOTE_ID,
    ...body,
    createdAt: new Date('2026-11-18T09:00:00.000Z'),
    sentAt,
  };
  const repository = {
    state: vi.fn(async () => ({ tipsEnabled: true, news: [note] })),
    byId: vi.fn(async (id: string) => (id === NOTE_ID ? note : null)),
    writeSwitch: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
    send: vi.fn(async () => sendWins),
  };
  const service = new PersonMailService(repository as unknown as PersonMailRepository);
  return { service, repository };
}

describe('EMAILBUILD2 — person mail (platform)', () => {
  it('lists the switch and the notes', async () => {
    const view = await harness().service.state(ctx);
    expect(view.tipsEnabled).toBe(true);
    expect(view.news[0]).toMatchObject({ id: NOTE_ID, sentAt: null, link: '/work' });
  });

  it('turns the switch off with an audit row, and refuses a non-boolean', async () => {
    const { service, repository } = harness();
    await service.setSwitch(actor, { enabled: false }, ctx);
    expect(repository.writeSwitch).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ action: 'platform.person_mail_switched_off', actorUserId: 'u' }),
    );
    await expect(service.setSwitch(actor, { enabled: 'no' }, ctx)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('saves a valid note with an audit row', async () => {
    const { service, repository } = harness();
    await service.createNews(actor, body, ctx);
    expect(repository.insert).toHaveBeenCalledWith(
      expect.any(String),
      body,
      'u',
      expect.objectContaining({ action: 'platform.feature_news_added' }),
    );
  });

  it('refuses empty or long text, line breaks and unsafe links', () => {
    expect(() => parseFeatureNews({ ...body, titleEn: '' })).toThrow();
    expect(() => parseFeatureNews({ ...body, bodyEn: 'x'.repeat(401) })).toThrow();
    expect(() => parseFeatureNews({ ...body, titleEn: 'A\r\nBcc: x' })).toThrow();
    for (const link of [
      'javascript:alert(1)',
      '//evil.example',
      'http://example.com',
      'work',
      '/work\\x',
      '/ملفات',
    ]) {
      expect(() => parseFeatureNews({ ...body, link }), link).toThrow();
    }
    expect(parseFeatureNews({ ...body, link: 'https://tmanageapp.com/changelog' }).link).toBe(
      'https://tmanageapp.com/changelog',
    );
  });

  it('sends a note once: a second press is a 409, an unknown id a 404', async () => {
    const fresh = harness();
    await fresh.service.sendNews(actor, NOTE_ID, ctx);
    expect(fresh.repository.send).toHaveBeenCalledWith(
      NOTE_ID,
      'u',
      expect.objectContaining({ action: 'platform.feature_news_sent' }),
    );
    await expect(harness(new Date()).service.sendNews(actor, NOTE_ID, ctx)).rejects.toMatchObject({
      status: 409,
    });
    await expect(harness(null, false).service.sendNews(actor, NOTE_ID, ctx)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      harness().service.sendNews(actor, '0199aa00-0000-7000-8000-0000000000ff', ctx),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('every route sits behind the platform-admin guard and a platform permission', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PlatformPersonMailController)).toContain(
      PlatformAdminGuard,
    );
    for (const handler of ['state', 'setSwitch', 'createNews', 'sendNews'] as const) {
      expect(
        Reflect.getMetadata(
          PLATFORM_PERMISSION_METADATA,
          PlatformPersonMailController.prototype[handler],
        ),
        handler,
      ).toBe('platform.settings.edit');
    }
  });
});
