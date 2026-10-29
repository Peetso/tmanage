import { describe, expect, it, vi } from 'vitest';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type {
  AnnouncementRecord,
  PlatformAnnouncementsRepository,
} from './announcements.repository.js';
import {
  PlatformAnnouncementsService,
  announcementStatus,
  parseAnnouncementBody,
  pickPublicAnnouncement,
} from './announcements.service.js';

/** PA-10 · D3: EN/AR, window, audience, dismissible, publish/unpublish. */

const ctx = { correlationId: 'c', ip: null, userAgent: null };
const actor: PlatformAdminActor = {
  account: {
    userId: 'u',
    email: 'peter@example.com',
    displayName: 'Peter',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 's',
  stepUp: null,
};
const NOW = new Date('2026-11-01T12:00:00Z');
const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const ID = '0199aa00-0000-7000-8000-0000000000a1';

function record(over: Partial<AnnouncementRecord> = {}): AnnouncementRecord {
  return {
    id: ID,
    titleEn: 'Planned maintenance on 2 Nov',
    titleAr: '‏صيانة مجدولة يوم ٢ نوفمبر',
    bodyEn: 'TManage will be read-only from 22:00.',
    bodyAr: '‏سيكون TManage للقراءة فقط',
    severity: 'warning',
    linkUrl: null,
    audience: 'everyone',
    audienceOrganizationIds: [],
    dismissible: true,
    startsAt: null,
    endsAt: null,
    published: true,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe('announcementStatus', () => {
  it('draft, scheduled, live, expired', () => {
    expect(announcementStatus(record({ published: false }), NOW)).toBe('draft');
    expect(announcementStatus(record({ startsAt: new Date('2026-11-02T00:00:00Z') }), NOW)).toBe(
      'scheduled',
    );
    expect(announcementStatus(record(), NOW)).toBe('live');
    expect(announcementStatus(record({ endsAt: new Date('2026-11-01T00:00:00Z') }), NOW)).toBe(
      'expired',
    );
  });
});

describe('pickPublicAnnouncement', () => {
  const app = { surface: 'app' as const, organizationId: ORG };

  it('returns the banner in Arabic for ar, English otherwise', () => {
    expect(pickPublicAnnouncement([record()], app, 'ar', NOW)).toMatchObject({
      locale: 'ar',
      title: '‏صيانة مجدولة يوم ٢ نوفمبر',
      dismissible: true,
    });
    expect(pickPublicAnnouncement([record()], app, 'en', NOW)?.title).toBe(
      'Planned maintenance on 2 Nov',
    );
  });

  it('falls back to English when no Arabic was written', () => {
    const view = pickPublicAnnouncement([record({ titleAr: null, bodyAr: null })], app, 'ar', NOW);
    expect(view?.locale).toBe('en');
  });

  it('respects the window and drafts', () => {
    expect(pickPublicAnnouncement([record({ published: false })], app, 'en', NOW)).toBeNull();
    expect(
      pickPublicAnnouncement(
        [record({ startsAt: new Date('2026-11-02T00:00:00Z') })],
        app,
        'en',
        NOW,
      ),
    ).toBeNull();
  });

  it('respects the audience: chosen organizations in their app, clients in portals', () => {
    const chosen = record({ audience: 'organizations', audienceOrganizationIds: [ORG] });
    expect(pickPublicAnnouncement([chosen], app, 'en', NOW)).not.toBeNull();
    expect(
      pickPublicAnnouncement([chosen], { surface: 'app', organizationId: null }, 'en', NOW),
    ).toBeNull();
    const clients = record({ audience: 'clients' });
    expect(pickPublicAnnouncement([clients], app, 'en', NOW)).toBeNull();
    expect(
      pickPublicAnnouncement([clients], { surface: 'portal', organizationId: null }, 'en', NOW),
    ).not.toBeNull();
  });

  it('shows the most severe one first', () => {
    const info = record({ id: 'a', severity: 'info' });
    const critical = record({ id: 'b', severity: 'critical' });
    expect(pickPublicAnnouncement([info, critical], app, 'en', NOW)?.id).toBe('b');
  });
});

describe('parseAnnouncementBody', () => {
  it('English title and message are required; the end must follow the start', () => {
    expect(() => parseAnnouncementBody({ bodyEn: 'x' })).toThrow();
    expect(() =>
      parseAnnouncementBody({
        titleEn: 'a',
        bodyEn: 'b',
        startsAt: '2026-11-02T00:00:00Z',
        endsAt: '2026-11-01T00:00:00Z',
      }),
    ).toThrow();
  });

  it('chosen organizations need at least one id; a bare host becomes https', () => {
    expect(() =>
      parseAnnouncementBody({ titleEn: 'a', bodyEn: 'b', audience: 'organizations' }),
    ).toThrow();
    expect(
      parseAnnouncementBody({ titleEn: 'a', bodyEn: 'b', linkUrl: 'tmanage.peetrix.com/status' })
        .linkUrl,
    ).toBe('https://tmanage.peetrix.com/status');
  });
});

describe('PlatformAnnouncementsService', () => {
  function harness() {
    const repository = {
      create: vi.fn(async () => ID),
      find: vi.fn(async () => record({ published: false })),
      update: vi.fn(async () => true),
      setPublished: vi.fn(async () => true),
      archive: vi.fn(async () => true),
      list: vi.fn(async () => []),
    } as unknown as PlatformAnnouncementsRepository;
    return { service: new PlatformAnnouncementsService(repository), repository };
  }

  it('publish and unpublish write the audit action', async () => {
    const { service, repository } = harness();
    await service.setPublished(actor, ID, true, {}, ctx);
    await service.setPublished(actor, ID, false, {}, ctx);
    expect(repository.setPublished).toHaveBeenNthCalledWith(
      1,
      ID,
      true,
      expect.objectContaining({ action: 'platform.announcement_published' }),
    );
    expect(repository.setPublished).toHaveBeenNthCalledWith(
      2,
      ID,
      false,
      expect.objectContaining({ action: 'platform.announcement_unpublished' }),
    );
  });

  it('delete archives (no hard delete) and 404s an unknown id', async () => {
    const { service, repository } = harness();
    expect(await service.archive(actor, ID, {}, ctx)).toEqual({ archived: true });
    vi.mocked(repository.archive).mockResolvedValueOnce(false);
    await expect(service.archive(actor, ID, {}, ctx)).rejects.toMatchObject({ status: 404 });
    await expect(service.archive(actor, 'nope', {}, ctx)).rejects.toMatchObject({ status: 404 });
  });

  it('PATCH merges over the stored announcement', async () => {
    const { service, repository } = harness();
    await service.update(actor, ID, { dismissible: false }, ctx);
    expect(repository.update).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ dismissible: false, titleEn: 'Planned maintenance on 2 Nov' }),
      expect.objectContaining({ action: 'platform.announcement_updated' }),
    );
  });
});
