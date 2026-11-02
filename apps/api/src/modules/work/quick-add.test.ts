import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkingCalendarRepository } from '../working-calendar/working-calendar.repository.js';
import { WorkQuickAddController } from './quick-add.controller.js';
import type { QuickAddRepository } from './quick-add.repository.js';
import { QuickAddService } from './quick-add.service.js';

/** 55-25 — quick-add resolve. 2026-11-05 is a Thursday; the org works Sun–Thu, 11-08 is a holiday. */
const context = { organizationId: 'org-1', userId: 'u-1' } as unknown as TenantContext;
const run = (_c: unknown, work: (r: never) => unknown) => work({} as never);
const db = { read: run, transaction: run } as unknown as TenantDatabase;
const member = {
  userId: 'u-1',
  organizationId: 'org-1',
  kind: 'internal',
  role: 'member',
  membershipId: 'm-1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: ['p-1'],
  hasOrgWideScope: false,
} as unknown as Principal;

const calendars = {
  findCalendar: () =>
    Promise.resolve({
      id: 'cal-1',
      workingDaysMask: 31,
      dayStart: '09:00',
      dayEnd: '17:00',
      timeZone: 'Asia/Riyadh',
    }),
  listHolidays: () => Promise.resolve([{ date: '2026-11-08' }]),
} as unknown as WorkingCalendarRepository;

/** People per project: «سارة محمد» is on p-2 only, which the caller cannot read. */
function repository(digits: 'latn' | 'arab' = 'latn'): QuickAddRepository {
  const onP1 = [
    { userId: 'u-omar', displayName: 'عمر خالد' },
    { userId: 'u-lina1', displayName: 'Lina Haddad' },
    { userId: 'u-lina2', displayName: 'Lina Saleh' },
  ];
  return {
    listPeople: (_r: never, _c: never, projectId: string | null) =>
      Promise.resolve(
        projectId === 'p-2' ? [{ userId: 'u-sara', displayName: 'سارة محمد' }] : onP1,
      ),
    listProjects: () =>
      Promise.resolve([
        { id: 'p-1', organizationId: 'org-1', name: 'حملة رمضان' },
        { id: 'p-2', organizationId: 'org-1', name: 'Secret Launch' },
      ]),
    digits: () => Promise.resolve(digits),
  } as unknown as QuickAddRepository;
}

const at = () => new Date('2026-11-05T08:00:00Z');

describe('quick-add resolve (55-25)', () => {
  it('keeps a person and a project the caller cannot see in the title, never as candidates', async () => {
    const service = new QuickAddService(db, repository(), calendars, at);
    const view = await service.resolve(context, member, 'مراجعة العقد لسارة #secret غدا', null);
    expect(view.title).toBe('مراجعة العقد لسارة #secret');
    expect(view.chips.map((chip) => chip.kind)).toEqual(['date']);
    expect(JSON.stringify(view)).not.toContain('u-sara');
    expect(JSON.stringify(view)).not.toContain('p-2');
  });

  it('returns candidates without a value when a name is ambiguous, and an id when it is not', async () => {
    const service = new QuickAddService(db, repository(), calendars, at);
    const view = await service.resolve(context, member, 'Design review for Lina @عمر', 'p-1');
    const owner = view.chips.find((chip) => chip.kind === 'owner');
    expect(owner?.value).toBeNull();
    expect(owner?.candidates.map((c) => c.id).sort()).toEqual(['u-lina1', 'u-lina2']);
    expect(view.title).toBe('Design review @عمر');
    const single = await service.resolve(context, member, '@عمر #حملة_رمضان مهم', null);
    expect(single.chips.map((chip) => [chip.kind, chip.value])).toEqual([
      ['owner', 'u-omar'],
      ['project', 'p-1'],
      ['priority', 'p2'],
    ]);
  });

  it('moves dates off weekends and holidays, and labels them in the org digits', async () => {
    const service = new QuickAddService(db, repository('arab'), calendars, at);
    const view = await service.resolve(context, member, 'إرسال الفاتورة غدًا ساعتين', null);
    expect(view.today).toBe('2026-11-05');
    expect(view.chips.map((chip) => [chip.value, chip.label])).toEqual([
      ['2026-11-09', '٢٠٢٦-١١-٠٩'],
      [120, '٢h'],
    ]);
  });

  it('refuses q over 300 characters and an unreadable projectId', async () => {
    const service = new QuickAddService(db, repository(), calendars, at);
    const controller = new WorkQuickAddController(service);
    expect(() => controller.resolve(context, member, 'x'.repeat(301), undefined)).toThrow(
      expect.objectContaining({ status: 400 }) as ApiError,
    );
    await expect(service.resolve(context, member, 'x'.repeat(301), null)).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.resolve(context, member, 'x', 'p-2')).rejects.toMatchObject({
      status: 404,
    });
  });
});
