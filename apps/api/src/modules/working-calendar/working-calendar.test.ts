import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { OrgHolidayRow, OrgWorkingCalendarRow } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { WorkingCalendarService, clientHolidayProjection } from './working-calendar.service.js';
import type { WorkingCalendarServiceOptions } from './working-calendar.service.js';
import { parseCalendarInput } from './working-calendar.validate.js';

/** 53-02 — the working calendar's rules over in-memory fakes and the real `authorize`. */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const context = { organizationId: ORG, userId: 'u1', membershipId: 'm1' } as TenantContext;
const principal: Principal = {
  userId: 'u1',
  organizationId: ORG,
  kind: 'internal',
  role: 'org_admin',
  membershipId: 'm1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT],
  hasOrgWideScope: true,
};
const SUN_THU = { workingDays: [0, 1, 2, 3, 4], dayStart: '09:00', dayEnd: '17:00' };

function harness() {
  const calendars = new Map<string, OrgWorkingCalendarRow>();
  const holidays: OrgHolidayRow[] = [];
  const audits: string[] = [];
  const key = (projectId: string | null) => projectId ?? 'org';
  const options: WorkingCalendarServiceOptions = {
    database: {
      read: (_c, f) => f({} as never),
      transaction: (_c, f) => f({} as never),
    } as WorkingCalendarServiceOptions['database'],
    repository: {
      findCalendar: async (_r, _c, projectId) => calendars.get(key(projectId)) ?? null,
      insertCalendar: async (_r, _c, projectId, values) => {
        const row = {
          id: `cal-${key(projectId)}`,
          organizationId: ORG,
          scope: projectId === null ? 'org' : 'project',
          projectId,
          ...values,
          version: 1,
        } as OrgWorkingCalendarRow;
        calendars.set(key(projectId), row);
        return row;
      },
      updateCalendar: async (_r, _c, id, version, values) => {
        for (const [k, row] of calendars) {
          if (row.id === id && row.version === version) {
            calendars.set(k, { ...row, ...values, version: version + 1 });
            return 1;
          }
        }
        return 0;
      },
      deleteCalendar: async () => 1,
      listHolidays: async (_r, _c, calendarId) =>
        holidays.filter((h) => h.calendarId === calendarId),
      countHolidays: async () => holidays.length,
      insertHolidays: async (_r, _c, calendarId, rows) =>
        rows.map((row, i) => {
          const id = `h${String(holidays.length + i)}`;
          holidays.push({ id, calendarId, ...row } as OrgHolidayRow);
          return id;
        }),
      deleteHoliday: async () => 1,
      organizationTimeZone: async () => 'Asia/Riyadh',
      projectExists: async () => true,
    },
    audit: { record: async (_r, _c, e) => (audits.push(e.action), {}) as never },
    now: () => new Date('2026-10-21T09:00:00Z'),
  };
  return { service: new WorkingCalendarService(options), holidays, audits };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { status?: number; details?: readonly { message: string }[] }) =>
      `${String(e.status)}:${e.details?.[0]?.message ?? ''}`,
  );

describe('53-02 working calendar', () => {
  it('refuses a week with no working day', () => {
    expect(() =>
      parseCalendarInput({ ...SUN_THU, workingDays: [], timeZone: 'UTC', version: 0 }),
    ).toThrow(/invalid/);
  });

  it('caps a calendar at 400 holidays: the 401st is refused', async () => {
    const { service, holidays } = harness();
    for (let i = 0; i < 400; i += 1) {
      holidays.push({ id: `x${String(i)}`, calendarId: 'cal-org', date: `d${String(i)}` } as never);
    }
    await service.updateOrg(context, principal, { ...SUN_THU, timeZone: 'UTC', version: 0 });
    expect(
      await code(service.addHoliday(context, principal, { date: '2027-01-05', labelEn: 'Day' })),
    ).toBe('400:at most 400 holidays per calendar');
  });

  it('imports a pack once and returns 409 on a stale version', async () => {
    const { service, audits } = harness();
    const first = await service.importPack(context, principal, { packKey: 'ksa-2026' });
    const again = await service.importPack(context, principal, { packKey: 'ksa-2026' });
    expect(first.holidays).toHaveLength(9);
    expect(again.holidays).toHaveLength(9);
    expect(audits).toContain('working_calendar.holidays_imported');
    expect(
      await code(
        service.updateOrg(context, principal, { ...SUN_THU, timeZone: 'UTC', version: 7 }),
      ),
    ).toBe('409:working_calendar_version_conflict');
  });

  it('lets a project override win over the org calendar, holidays kept, label-only projection', async () => {
    const { service } = harness();
    await service.importPack(context, principal, { packKey: 'uae-2026' });
    const inherited = await service.getProject(context, principal, PROJECT);
    expect(inherited.inherited).toBe(true);
    await service.updateProject(context, principal, PROJECT, {
      workingDays: [1, 2, 3, 4, 5],
      dayStart: '08:00',
      dayEnd: '16:00',
      timeZone: 'Asia/Dubai',
      version: 0,
    });
    const effective = await service.getProject(context, principal, PROJECT);
    expect(effective.workingDays).toEqual([1, 2, 3, 4, 5]);
    expect(effective.inherited).toBe(false);
    expect(effective.holidays.length).toBeGreaterThan(0);
    expect(Object.keys(clientHolidayProjection(effective)[0] ?? {})).toEqual([
      'date',
      'labelEn',
      'labelAr',
    ]);
  });
});
