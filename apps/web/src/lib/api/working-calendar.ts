import type { ApiClient } from './client';

/**
 * 53-02 — the company working calendar: working days, day hours, time zone and holidays (typed
 * one by one or imported from a shipped country pack). Reading is `work.read`; every change is
 * `org.manage`, decided by the API.
 */

export interface CalendarHoliday {
  readonly id: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly labelEn: string;
  readonly labelAr: string | null;
  /** `manual` or `pack`. */
  readonly source: string;
  readonly packKey: string | null;
  readonly packVersion: string | null;
  /** A Hijri date that is not announced yet. */
  readonly estimated: boolean;
}

export interface WorkingCalendar {
  readonly scope: 'org' | 'project';
  readonly projectId: string | null;
  readonly isDefault: boolean;
  readonly inherited: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  readonly workingDays: readonly number[];
  /** `HH:MM`. */
  readonly dayStart: string;
  readonly dayEnd: string;
  readonly timeZone: string;
  /** 0 when nothing is stored yet; an update presents the version it read. */
  readonly version: number;
  readonly holidays: readonly CalendarHoliday[];
}

export interface WorkingCalendarInput {
  readonly workingDays: readonly number[];
  readonly dayStart: string;
  readonly dayEnd: string;
  readonly timeZone: string;
  readonly version: number;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/working-calendar`;
}

export async function getWorkingCalendar(
  client: ApiClient,
  organizationSlug: string,
): Promise<WorkingCalendar> {
  const { data } = await client.request<WorkingCalendar>({ path: base(organizationSlug) });
  return data;
}

export async function updateWorkingCalendar(
  client: ApiClient,
  organizationSlug: string,
  input: WorkingCalendarInput,
): Promise<WorkingCalendar> {
  const { data } = await client.request<WorkingCalendar>({
    method: 'PUT',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

export async function addHoliday(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly date: string; readonly labelEn: string; readonly labelAr: string | null },
): Promise<CalendarHoliday> {
  const { data } = await client.request<CalendarHoliday>({
    method: 'POST',
    path: `${base(organizationSlug)}/holidays`,
    body: input,
  });
  return data;
}

export async function deleteHoliday(
  client: ApiClient,
  organizationSlug: string,
  holidayId: string,
): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/holidays/${encodeURIComponent(holidayId)}`,
  });
}

export async function importHolidayPack(
  client: ApiClient,
  organizationSlug: string,
  packKey: string,
): Promise<WorkingCalendar> {
  const { data } = await client.request<WorkingCalendar>({
    method: 'POST',
    path: `${base(organizationSlug)}/import-pack`,
    body: { packKey },
  });
  return data;
}

/** Toggle one weekday in a working-days list, kept sorted Sunday-first. */
export function toggleWeekday(days: readonly number[], day: number): number[] {
  const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
  return [...next].sort((a, b) => a - b);
}
