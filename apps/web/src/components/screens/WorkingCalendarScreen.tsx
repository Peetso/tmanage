'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Checkbox, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { HOLIDAY_PACK_KEYS, holidayPack } from '@tmanage/domain';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import {
  addHoliday,
  deleteHoliday,
  getWorkingCalendar,
  importHolidayPack,
  toggleWeekday,
  updateWorkingCalendar,
} from '../../lib/api/working-calendar';
import type { WorkingCalendar } from '../../lib/api/working-calendar';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/r48-iterations-calendar.css';

/** English copy; the keys reach the catalogs through the R48 L3 i18n fragment. */
export const CALENDAR_COPY = {
  title: 'Working calendar',
  crumb: 'Working calendar',
  description: 'Working days, hours and holidays for the whole company',
  loading: 'Loading the working calendar',
  loadFailed: 'The working calendar could not be loaded',
  week: 'Working week',
  day0: 'Sunday',
  day1: 'Monday',
  day2: 'Tuesday',
  day3: 'Wednesday',
  day4: 'Thursday',
  day5: 'Friday',
  day6: 'Saturday',
  dayStart: 'Day starts',
  dayEnd: 'Day ends',
  timeZone: 'Time zone',
  timeZoneHint: 'An IANA zone, for example Asia/Riyadh.',
  save: 'Save calendar',
  saving: 'Saving',
  saved: 'Calendar saved',
  saveFailed: 'The calendar could not be saved',
  noDay: 'Pick at least one working day.',
  holidays: 'Holidays',
  pack: "Add a country's public holidays",
  addPack: 'Add holidays',
  estimatedNote: 'Hijri holiday dates are estimates until they are announced.',
  date: 'Date',
  labelEn: 'Name in English',
  labelAr: 'Name in Arabic',
  addHoliday: 'Add holiday',
  holidayFailed: 'The holiday could not be changed',
  noHolidays: 'No holidays yet.',
  manual: 'Manual',
  fromPack: 'Pack',
  estimated: 'estimated',
  remove: 'Remove',
  removeHoliday: 'Remove holiday:',
} as const;

type CopyKey = keyof typeof CALENDAR_COPY;

const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const COUNTRY: Readonly<Record<string, string>> = {
  SA: 'Saudi Arabia',
  AE: 'United Arab Emirates',
  EG: 'Egypt',
};

/** "Saudi Arabia 2027" for a shipped pack key. */
export function packLabel(packKey: string): string {
  const pack = holidayPack(packKey);
  if (pack === null) return packKey;
  return `${COUNTRY[pack.country] ?? pack.country} ${pack.year}`;
}

export interface WorkingCalendarScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Working calendar (53-02)** — Figma 590:33665 (EN) / 590:33792 (AR).
 *
 * The company's working week (days, hours, zone) and its holidays: one at a time, or a whole
 * country's year from a shipped pack. Due dates, iterations and schedules count working days on
 * this calendar. The API gates every change on `org.manage`; a refusal is shown in words.
 */
export function WorkingCalendarScreen({
  organizationSlug,
  organizationName,
  client,
}: WorkingCalendarScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const c = (key: CopyKey) => tOr(`WorkingCalendarScreen.${key}`, CALENDAR_COPY[key]);
  const describeError = useDescribeApiError();
  const queryClient = useQueryClient();
  const queryKey = ['working-calendar', organizationSlug] as const;
  const calendar = useQuery({
    queryKey,
    queryFn: () => getWorkingCalendar(api, organizationSlug),
  });

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="working-calendar"
      crumbs={[c('crumb')]}
      title={c('title')}
      description={c('description')}
      client={api}
    >
      {calendar.isPending ? (
        <LoadingRegion label={c('loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}
      {calendar.isError ? (
        <InlineAlert tone="danger" title={c('loadFailed')} live>
          {describeError(calendar.error)}
        </InlineAlert>
      ) : null}
      {calendar.isSuccess ? (
        <div className="tm-prj__grid tm-prj__grid--aside">
          <div className="tm-prj__col tm-prj__col--aside">
            <WeekCard
              key={calendar.data.version}
              calendar={calendar.data}
              c={c}
              onSave={async (input) => {
                const saved = await updateWorkingCalendar(api, organizationSlug, input);
                queryClient.setQueryData(queryKey, saved);
              }}
            />
          </div>
          <div className="tm-prj__col">
            <HolidaysCard
              calendar={calendar.data}
              c={c}
              api={api}
              organizationSlug={organizationSlug}
              onChanged={async () => {
                await queryClient.invalidateQueries({ queryKey });
              }}
            />
          </div>
        </div>
      ) : null}
    </ControlCenterShell>
  );
}

function WeekCard({
  calendar,
  c,
  onSave,
}: {
  calendar: WorkingCalendar;
  c: (key: CopyKey) => string;
  onSave: (input: {
    workingDays: number[];
    dayStart: string;
    dayEnd: string;
    timeZone: string;
    version: number;
  }) => Promise<void>;
}) {
  const describeError = useDescribeApiError();
  const [days, setDays] = useState<number[]>([...calendar.workingDays]);
  const [dayStart, setDayStart] = useState(calendar.dayStart);
  const [dayEnd, setDayEnd] = useState(calendar.dayEnd);
  const [timeZone, setTimeZone] = useState(calendar.timeZone);
  const save = useMutation({
    mutationFn: () =>
      onSave({ workingDays: days, dayStart, dayEnd, timeZone, version: calendar.version }),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (days.length > 0 && !save.isPending) save.mutate();
  }

  return (
    <section className="tm-r48-card" aria-labelledby="tm-cal-week">
      <h2 id="tm-cal-week" className="tm-r48-eyebrow">
        {c('week')}
      </h2>
      <form className="tm-stack" onSubmit={submit} noValidate>
        <fieldset className="tm-r48-days" disabled={save.isPending}>
          <legend className="tm-visually-hidden">{c('week')}</legend>
          {DAYS.map((day) => (
            <Checkbox
              key={day}
              name={`day-${day}`}
              label={c(`day${day}` as CopyKey)}
              checked={days.includes(day)}
              onChange={() => setDays((current) => toggleWeekday(current, day))}
            />
          ))}
        </fieldset>
        {days.length === 0 ? (
          <InlineAlert tone="warning" live>
            {c('noDay')}
          </InlineAlert>
        ) : null}
        <Field
          label={c('dayStart')}
          name="dayStart"
          type="time"
          value={dayStart}
          onChange={(event) => setDayStart(event.target.value)}
        />
        <Field
          label={c('dayEnd')}
          name="dayEnd"
          type="time"
          value={dayEnd}
          onChange={(event) => setDayEnd(event.target.value)}
        />
        <Field
          label={c('timeZone')}
          name="timeZone"
          value={timeZone}
          hint={c('timeZoneHint')}
          onChange={(event) => setTimeZone(event.target.value)}
        />
        {save.isError ? (
          <InlineAlert tone="danger" title={c('saveFailed')} live>
            {describeError(save.error)}
          </InlineAlert>
        ) : null}
        {save.isSuccess ? (
          <InlineAlert tone="success" live>
            {c('saved')}
          </InlineAlert>
        ) : null}
        <div className="tm-r48-actions">
          <Button
            type="submit"
            tone="ink"
            loading={save.isPending}
            loadingLabel={c('saving')}
            disabled={days.length === 0}
          >
            {c('save')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function HolidaysCard({
  calendar,
  c,
  api,
  organizationSlug,
  onChanged,
}: {
  calendar: WorkingCalendar;
  c: (key: CopyKey) => string;
  api: ApiClient;
  organizationSlug: string;
  onChanged: () => Promise<void>;
}) {
  const describeError = useDescribeApiError();
  const locale = useActiveLocale();
  const [packKey, setPackKey] = useState(HOLIDAY_PACK_KEYS[0] ?? '');
  const [date, setDate] = useState('');
  const [labelEn, setLabelEn] = useState('');
  const [labelAr, setLabelAr] = useState('');

  const change = useMutation({
    mutationFn: async (
      action: { kind: 'pack' } | { kind: 'add' } | { kind: 'remove'; holidayId: string },
    ) => {
      if (action.kind === 'pack') await importHolidayPack(api, organizationSlug, packKey);
      if (action.kind === 'add') {
        await addHoliday(api, organizationSlug, {
          date,
          labelEn: labelEn.trim(),
          labelAr: labelAr.trim() === '' ? null : labelAr.trim(),
        });
      }
      if (action.kind === 'remove') await deleteHoliday(api, organizationSlug, action.holidayId);
      return action.kind;
    },
    onSuccess: async (kind) => {
      if (kind === 'add') {
        setDate('');
        setLabelEn('');
        setLabelAr('');
      }
      await onChanged();
    },
  });
  const holidays = [...calendar.holidays].sort((a, b) => a.date.localeCompare(b.date));
  const canAdd = date !== '' && labelEn.trim() !== '';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canAdd && !change.isPending) change.mutate({ kind: 'add' });
  }

  return (
    <section className="tm-r48-card" aria-labelledby="tm-cal-holidays">
      <h2 id="tm-cal-holidays" className="tm-r48-eyebrow">
        {c('holidays')}
      </h2>
      <div className="tm-r48-actions">
        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-cal-pack">
            {c('pack')}
          </label>
          <select
            id="tm-cal-pack"
            className="tm-field__control"
            value={packKey}
            onChange={(event) => setPackKey(event.target.value)}
          >
            {HOLIDAY_PACK_KEYS.map((key) => (
              <option key={key} value={key}>
                {packLabel(key)}
              </option>
            ))}
          </select>
        </div>
        <Button
          tone="outline"
          disabled={packKey === '' || change.isPending}
          onClick={() => change.mutate({ kind: 'pack' })}
        >
          {c('addPack')}
        </Button>
      </div>
      <InlineAlert tone="neutral">{c('estimatedNote')}</InlineAlert>
      <form className="tm-r48-actions" onSubmit={submit} noValidate>
        <Field
          label={c('date')}
          name="date"
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
        <Field
          label={c('labelEn')}
          name="labelEn"
          value={labelEn}
          onChange={(event) => setLabelEn(event.target.value)}
        />
        <Field
          label={c('labelAr')}
          name="labelAr"
          dir="rtl"
          value={labelAr}
          onChange={(event) => setLabelAr(event.target.value)}
        />
        <Button type="submit" tone="ink" disabled={!canAdd || change.isPending}>
          {c('addHoliday')}
        </Button>
      </form>
      {change.isError ? (
        <InlineAlert tone="danger" title={c('holidayFailed')} live>
          {describeError(change.error)}
        </InlineAlert>
      ) : null}
      {holidays.length === 0 ? <p className="tm-r48-muted">{c('noHolidays')}</p> : null}
      <ul className="tm-r48-list">
        {holidays.map((holiday) => {
          const label =
            locale.startsWith('ar') && holiday.labelAr ? holiday.labelAr : holiday.labelEn;
          const source = holiday.source === 'pack' ? c('fromPack') : c('manual');
          return (
            <li key={holiday.id} className="tm-r48-row">
              <span className="tm-r48-date">{holiday.date}</span>
              <span className="tm-r48-row__title">{label}</span>
              <Badge>{holiday.estimated ? `${source} · ${c('estimated')}` : source}</Badge>
              <Button
                tone="text"
                size="compact"
                aria-label={`${c('removeHoliday')} ${label}`}
                disabled={change.isPending}
                onClick={() => change.mutate({ kind: 'remove', holidayId: holiday.id })}
              >
                {c('remove')}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
