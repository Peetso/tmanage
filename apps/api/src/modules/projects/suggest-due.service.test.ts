import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { isWorkingDay, defaultWorkingCalendar } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkingCalendarRepository } from '../working-calendar/working-calendar.repository.js';
import type { ProjectsRepository } from './projects.repository.js';
import { SuggestDueController } from './suggest-due.controller.js';
import { SuggestDueService } from './suggest-due.service.js';
import type { DatedItem } from './suggest-due.repository.js';

/** 55-07 suggest-due over fakes. 2026-10-22 is a Thursday; the org works Sun–Thu in Riyadh. */
const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const context = { organizationId: ORG, membershipId: 'm1' } as unknown as TenantContext;

function principal(projectIds: string[]): Principal {
  return {
    userId: 'u1',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'm1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

function serviceWith(items: DatedItem[], project: object | null = { archivedAt: null }) {
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const projects = { findById: async () => project } as unknown as ProjectsRepository;
  const calendars = {
    findCalendar: async () => null,
    organizationTimeZone: async () => 'Asia/Riyadh',
    listHolidays: async () => [],
  } as unknown as WorkingCalendarRepository;
  return new SuggestDueService(
    database,
    projects,
    calendars,
    () => new Date('2026-10-22T09:00:00Z'),
    async () => items,
  );
}

const at = (iso: string) => new Date(`${iso}T09:00:00Z`);

describe('SuggestDueService (55-07)', () => {
  it('suggests the next working day with no dated items — never a weekend', async () => {
    const result = await serviceWith([]).suggest(context, principal([PROJECT]), PROJECT);
    expect(result).toEqual({ date: '2026-10-25', reason: 'next_working_day' });
  });

  it('uses the project pace, clamped to 10 working days, on a working day', async () => {
    const slow = [{ createdAt: at('2026-01-04'), dueAt: at('2026-06-04') }];
    const result = await serviceWith(slow).suggest(context, principal([PROJECT]), PROJECT);
    expect(result.reason).toBe('project_pace');
    expect(isWorkingDay(result.date, defaultWorkingCalendar('Asia/Riyadh'))).toBe(true);
    // Thu + 10 Sun–Thu working days = Thu 2026-11-05.
    expect(result.date).toBe('2026-11-05');
  });

  it('404s a project the caller cannot read, and guards the route with work.read', async () => {
    const error = await serviceWith([])
      .suggest(context, principal([]), PROJECT)
      .catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(404);
    const missing = await serviceWith([], null)
      .suggest(context, principal([PROJECT]), PROJECT)
      .catch((e: unknown) => e);
    expect((missing as ApiError).status).toBe(404);
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, SuggestDueController.prototype.get)).toBe(
      'work.read',
    );
  });
});
