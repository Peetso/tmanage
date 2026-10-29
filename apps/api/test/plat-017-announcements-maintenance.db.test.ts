import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { ApiError } from '../src/common/http/errors.js';
import type { PlatformAdminActor } from '../src/modules/platform-admin/platform-admin.guard.js';
import { PlatformAnnouncementsRepository } from '../src/modules/platform-admin/settings/announcements.repository.js';
import {
  PlatformAnnouncementsService,
  pickPublicAnnouncement,
} from '../src/modules/platform-admin/settings/announcements.service.js';
import { assertSignInOpen } from '../src/modules/platform/maintenance.controller.js';
import { MaintenanceWindowsRepository } from '../src/modules/platform/maintenance.repository.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';

/**
 * PLAT-017 against a real server — Announcements and maintenance windows (PA-10, SPEC §4 D3–D4,
 * migration 0244).
 *
 * 1. An announcement written in English and Arabic persists; the live read returns it inside its
 *    window, in Arabic for Arabic readers; a chosen-organizations banner reaches only that
 *    organization (resolved from its slug); unpublish and Delete (archive) take it away, audited.
 * 2. A `down` window with `block_sign_in` refuses a member's sign-in with the maintenance message
 *    (Arabic when asked) and lets a platform admin in; End now marks it ended and opens sign-in.
 */

let db: TestDatabase;
let tenant: TenantDatabase;
let world: SeedWorld;
let announcements: PlatformAnnouncementsService;
let announcementsRepository: PlatformAnnouncementsRepository;
let maintenance: MaintenanceWindowsRepository;

function context() {
  return { correlationId: uuidv7(), ip: '203.0.113.7', userAgent: 'vitest' };
}

function actor(): PlatformAdminActor {
  return {
    account: {
      userId: world.platformAdmin.id,
      email: world.platformAdmin.email,
      displayName: 'Platform',
      emailVerified: true,
      mfaEnabled: false,
    },
    sessionId: 'plat-017',
    stepUp: { expiresAt: new Date(Date.now() + 10 * 60_000), mfaVerified: false },
  };
}

function audit(action: string) {
  return {
    actorUserId: world.platformAdmin.id,
    actorEmail: world.platformAdmin.email,
    action,
    targetType: 'platform' as const,
    targetId: null,
    targetLabel: null,
    reason: 'Database upgrade window',
    correlationId: uuidv7(),
  };
}

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  announcementsRepository = new PlatformAnnouncementsRepository(tenant);
  announcements = new PlatformAnnouncementsService(announcementsRepository);
  maintenance = new MaintenanceWindowsRepository(tenant);
  await db.admin.query('TRUNCATE TABLE maintenance_windows');
});

afterAll(async () => {
  await db?.stop();
});

describe('Announcements (PLAT-017)', () => {
  it('publishes EN/AR, reaches the chosen organization only, and unpublishes / archives', async () => {
    const northstar = world.northstar.organizationId;
    const created = await announcements.create(
      actor(),
      {
        titleEn: 'Planned maintenance on 2 Nov',
        titleAr: '‏صيانة مجدولة يوم 2 نوفمبر',
        bodyEn: 'TManage will be read-only from 22:00.',
        bodyAr: '‏سيكون TManage للقراءة فقط من 22:00.',
        severity: 'warning',
        audience: 'organizations',
        audienceOrganizationIds: [northstar],
        dismissible: true,
        published: true,
      },
      context(),
    );
    expect(created.status).toBe('live');

    const now = new Date();
    const live = await announcementsRepository.live(now, uuidv7());
    expect(live.map((row) => row.id)).toContain(created.id);
    const [org] = await observe('select slug from organizations where id = ?', [northstar]);
    const resolved = await announcementsRepository.organizationIdForSlug(
      String(org?.['slug']),
      uuidv7(),
    );
    expect(resolved).toBe(northstar);
    expect(
      pickPublicAnnouncement(live, { surface: 'app', organizationId: resolved }, 'ar', now),
    ).toMatchObject({ locale: 'ar', title: '‏صيانة مجدولة يوم 2 نوفمبر' });
    expect(
      pickPublicAnnouncement(
        live,
        { surface: 'app', organizationId: world.twin.organizationId },
        'en',
        now,
      ),
    ).toBeNull();

    await announcements.setPublished(actor(), created.id, false, {}, context());
    expect(
      (await announcementsRepository.live(new Date(), uuidv7())).map((row) => row.id),
    ).not.toContain(created.id);
    await announcements.archive(actor(), created.id, {}, context());
    expect((await announcements.list(context())).announcements).toHaveLength(0);

    const actions = (
      await observe(
        `select action from platform_admin_audit_events
          where target_id = ? order by created_at, action`,
        [created.id],
      )
    ).map((row) => String(row['action']));
    expect(actions).toEqual(
      expect.arrayContaining([
        'platform.announcement_published',
        'platform.announcement_unpublished',
        'platform.announcement_archived',
      ]),
    );
  });
});

describe('Maintenance block_sign_in (PLAT-017)', () => {
  it('refuses a member, lets a platform admin in, and End now opens sign-in', async () => {
    const started = new Date(Date.now() - 60 * 60_000);
    const ends = new Date(Date.now() + 60 * 60_000);
    const { id } = await maintenance.schedule(
      {
        message: 'TManage is down for an upgrade',
        messageAr: '‏TManage متوقف للتحديث',
        severity: 'down',
        startsAt: started,
        endsAt: ends,
        published: true,
        blockSignIn: true,
      },
      audit('platform.maintenance_scheduled'),
    );
    const block = await maintenance.activeSignInBlock(new Date(), uuidv7());
    expect(block?.id).toBe(id);

    const member = world.northstar.designer.id;
    const refused = await assertSignInOpen(tenant, [], {
      userId: member,
      acceptLanguage: 'ar-EG,ar;q=0.9',
      correlationId: uuidv7(),
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(403);
    expect((refused as ApiError).message).toBe('‏TManage متوقف للتحديث');

    await expect(
      assertSignInOpen(tenant, [world.platformAdmin.email.toLowerCase()], {
        userId: world.platformAdmin.id,
        acceptLanguage: 'en',
        correlationId: uuidv7(),
      }),
    ).resolves.toBeUndefined();

    expect(await maintenance.end(id, new Date(), audit('platform.maintenance_ended'))).toBe(true);
    const [row] = await observe('select ended_at, ends_at from maintenance_windows where id = ?', [
      id,
    ]);
    expect(row?.['ended_at']).not.toBeNull();
    expect(await maintenance.activeSignInBlock(new Date(), uuidv7())).toBeNull();
    await expect(
      assertSignInOpen(tenant, [], {
        userId: member,
        acceptLanguage: 'en',
        correlationId: uuidv7(),
      }),
    ).resolves.toBeUndefined();
  });

  it('a degraded window never blocks sign-in, even with the switch on', async () => {
    await maintenance.schedule(
      {
        message: 'Slow search',
        severity: 'degraded',
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60 * 60_000),
        published: true,
        blockSignIn: true,
      },
      audit('platform.maintenance_scheduled'),
    );
    expect(await maintenance.activeSignInBlock(new Date(), uuidv7())).toBeNull();
  });
});
