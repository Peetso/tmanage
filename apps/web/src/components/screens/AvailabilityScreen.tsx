'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createAvailabilityWindow,
  deleteAvailabilityWindow,
  listOwnAvailability,
} from '../../lib/api/people-availability';
import type { AvailabilityView } from '../../lib/api/people-availability';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/people.css';

export interface AvailabilityScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** Overridable for tests; defaults to today. */
  today?: Date;
}

/** The fixed vocabulary a window's kind may take — mirrors the API's `AVAILABILITY_KINDS`. */
const KIND_VALUES: readonly string[] = ['vacation', 'sick', 'holiday', 'personal', 'other'];

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F'] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` for a UTC-midnight timestamp. */
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The ten working days (two Monday–Friday weeks) starting with the week that contains `today`. */
function fortnight(today: Date): { readonly weeks: readonly (readonly string[])[]; today: string } {
  const utc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const offset = (new Date(utc).getUTCDay() + 6) % 7; // days since Monday
  const monday = utc - offset * MS_PER_DAY;
  const week = (start: number) => [0, 1, 2, 3, 4].map((day) => isoDay(start + day * MS_PER_DAY));
  return { weeks: [week(monday), week(monday + 7 * MS_PER_DAY)], today: isoDay(utc) };
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function kindLabel(t: ReturnType<typeof useT>, kind: string): string {
  switch (kind) {
    case 'vacation':
      return t('AvailabilityScreen.kindVacation');
    case 'sick':
      return t('AvailabilityScreen.kindSick');
    case 'holiday':
      return t('AvailabilityScreen.kindHoliday');
    case 'personal':
      return t('AvailabilityScreen.kindPersonal');
    case 'other':
      return t('AvailabilityScreen.kindOther');
    default:
      return kind;
  }
}

/**
 * **Member availability / out-of-office (module 14 People & capacity, x218)**, drawn as PEO-04
 * "Availability · declared, never inferred · two weeks".
 *
 * `38-MODULE-MAP` §People & capacity. The caller reads their own out-of-office windows, adds one (a
 * start/end date, a kind, an optional note), and removes one — persisted behind `work.read`, scoped
 * to the caller's own membership by the server.
 *
 * The frame draws the whole team's fortnight. The read here is the caller's own windows, so the grid
 * carries one row — yours — with the same day tiles: grey for a declared working day, a dashed amber
 * tile for a day inside one of your windows, lime for today. The declare form sits in the context
 * column where the frame puts its collision card; nothing about other people is invented.
 */
export function AvailabilityScreen({
  organizationSlug,
  organizationName,
  client,
  today,
}: AvailabilityScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();

  const windows = useQuery({
    queryKey: ['availability', organizationSlug],
    queryFn: () => listOwnAvailability(api, organizationSlug),
  });

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [kind, setKind] = useState<string>(KIND_VALUES[0]!);
  const [note, setNote] = useState('');

  const add = useMutation({
    mutationFn: (): Promise<AvailabilityView> =>
      createAvailabilityWindow(api, organizationSlug, {
        startDate,
        endDate,
        kind,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['availability', organizationSlug] });
      setStartDate('');
      setEndDate('');
      setKind(KIND_VALUES[0]!);
      setNote('');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string): Promise<void> => deleteAvailabilityWindow(api, organizationSlug, id),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['availability', organizationSlug] });
    },
  });

  const list = useMemo(() => windows.data ?? [], [windows.data]);
  const span = useMemo(() => fortnight(today ?? new Date()), [today]);
  const days = span.weeks.flat();
  const awayKind = (day: string) =>
    list.find((window) => window.startDate <= day && day <= window.endDate)?.kind;
  const awayDays = days.filter((day) => awayKind(day) !== undefined).length;
  const first = days[0]!;
  const last = days[days.length - 1]!;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      eyebrow={`${t('AvailabilityScreen.eyebrowPrefix')} · ${shortDate(first)} – ${shortDate(last)}`}
      title={t('AvailabilityScreen.title')}
      actions={
        <a href="#tm-availability-start" className="tm-button tm-button--ink ppl-cta">
          {t('AvailabilityScreen.declareCta')}
        </a>
      }
    >
      <div className="ppl-screen">
        <ul className="ppl-legend" aria-label={t('AvailabilityScreen.legendLabel')}>
          <li>
            <span className="ppl-swatch" aria-hidden="true" />
            {t('AvailabilityScreen.legendWorking')}
          </li>
          <li>
            <span className="ppl-swatch ppl-swatch--away" aria-hidden="true" />
            {t('AvailabilityScreen.legendAway')}
          </li>
          <li>
            <span className="ppl-swatch ppl-swatch--today" aria-hidden="true" />
            {t('AvailabilityScreen.legendToday')}
          </li>
          <li className="ppl-legend__end ppl-mono ppl-mono--meta">
            {t('AvailabilityScreen.legendMonFri')}
          </li>
        </ul>

        <div className="ppl-body">
          <section
            className="ppl-card ppl-grid-card ppl-main"
            aria-labelledby="tm-availability-list-heading"
          >
            <h2 id="tm-availability-list-heading" className="tm-visually-hidden">
              {t('AvailabilityScreen.windowsHeading')}
            </h2>

            <div className="ppl-grid-scroll">
              <div className="ppl-grid" role="table" aria-label={t('AvailabilityScreen.gridLabel')}>
                <div className="ppl-grid__row ppl-grid__row--head" role="row">
                  <span className="ppl-grid__who ppl-mono" role="columnheader">
                    {t('AvailabilityScreen.thisWeekNextWeek')}
                  </span>
                  {span.weeks.map((week, index) => (
                    <WeekHead key={week[0]} week={week} gap={index > 0} />
                  ))}
                  <span className="ppl-grid__declared ppl-mono" role="columnheader">
                    {t('AvailabilityScreen.declared')}
                  </span>
                </div>
                <div className="ppl-grid__row" role="row">
                  <span className="ppl-grid__who" role="rowheader">
                    <span className="ppl-avatar ppl-avatar--32" aria-hidden="true">
                      {t('AvailabilityScreen.you')}
                    </span>
                    <span>
                      <span className="ppl-grid__name">{t('AvailabilityScreen.you')}</span>
                      <span className="ppl-grid__team">
                        {t('AvailabilityScreen.yourOwnWindows')}
                      </span>
                    </span>
                  </span>
                  {span.weeks.map((week, index) => (
                    <WeekCells
                      key={week[0]}
                      week={week}
                      gap={index > 0}
                      today={span.today}
                      awayKind={awayKind}
                      t={t}
                    />
                  ))}
                  <span className="ppl-grid__declared" role="cell">
                    <strong data-away={awayDays > 0}>
                      {awayDays === 0
                        ? t('AvailabilityScreen.fullFortnight')
                        : `${t('AvailabilityScreen.away')} ${awayDays} ${awayDays === 1 ? t('AvailabilityScreen.dayOne') : t('AvailabilityScreen.dayMany')}`}
                    </strong>
                    <span>
                      {list.length === 0
                        ? t('AvailabilityScreen.noDeclaredTimeOff')
                        : `${list.length} ${list.length === 1 ? t('AvailabilityScreen.windowOne') : t('AvailabilityScreen.windowMany')} ${t('AvailabilityScreen.onRecord')}`}
                    </span>
                  </span>
                </div>
              </div>
            </div>

            {windows.isPending ? (
              <LoadingRegion label={t('AvailabilityScreen.loadingAvailability')}>
                <Skeleton />
              </LoadingRegion>
            ) : windows.isError ? (
              <InlineAlert tone="danger" title={t('AvailabilityScreen.errorLoadTitle')}>
                {errorMessage(t, windows.error)}
              </InlineAlert>
            ) : list.length === 0 ? (
              <p className="ppl-note">{t('AvailabilityScreen.noWindowsRecorded')}</p>
            ) : (
              <ul className="ppl-windows">
                {list.map((window) => (
                  <li key={window.id} className="ppl-soft-row ppl-soft-row--roomy">
                    <span>
                      {window.startDate} → {window.endDate} · {kindLabel(t, window.kind)}
                      {window.note ? ` · ${window.note}` : ''}
                    </span>
                    <span className="ppl-soft-row__end">
                      <Button
                        type="button"
                        tone="destructive"
                        size="compact"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(window.id)}
                      >
                        {t('AvailabilityScreen.remove')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {remove.isError ? (
              <InlineAlert tone="danger" title={t('AvailabilityScreen.errorRemoveTitle')}>
                {errorMessage(t, remove.error)}
              </InlineAlert>
            ) : null}

            <div className="ppl-grid-card__foot">
              <p className="ppl-dashed-note">{t('AvailabilityScreen.dashedNote')}</p>
            </div>
          </section>

          <div className="ppl-aside ppl-aside--352">
            <form
              className="ppl-card ppl-card--tight ppl-form"
              aria-labelledby="tm-availability-add-heading"
              onSubmit={(event) => {
                event.preventDefault();
                add.mutate();
              }}
            >
              <h2 id="tm-availability-add-heading" className="ppl-card__title">
                {t('AvailabilityScreen.addHeading')}
              </h2>

              <div className="ppl-form__pair">
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-availability-start">
                    {t('AvailabilityScreen.startDate')}
                  </label>
                  <input
                    id="tm-availability-start"
                    className="tm-field__control"
                    type="date"
                    value={startDate}
                    required
                    onChange={(event) => setStartDate(event.target.value)}
                  />
                </div>

                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-availability-end">
                    {t('AvailabilityScreen.endDate')}
                  </label>
                  <input
                    id="tm-availability-end"
                    className="tm-field__control"
                    type="date"
                    value={endDate}
                    required
                    onChange={(event) => setEndDate(event.target.value)}
                  />
                </div>
              </div>

              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-availability-kind">
                  {t('AvailabilityScreen.kind')}
                </label>
                <select
                  id="tm-availability-kind"
                  className="tm-field__control"
                  value={kind}
                  onChange={(event) => setKind(event.target.value)}
                >
                  {KIND_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {kindLabel(t, value)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-availability-note">
                  {t('AvailabilityScreen.noteOptional')}
                </label>
                <input
                  id="tm-availability-note"
                  className="tm-field__control"
                  type="text"
                  value={note}
                  maxLength={500}
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>

              {add.isError ? (
                <InlineAlert tone="danger" title={t('AvailabilityScreen.errorAddTitle')}>
                  {errorMessage(t, add.error)}
                </InlineAlert>
              ) : null}

              <div>
                <Button type="submit" disabled={add.isPending}>
                  {add.isPending
                    ? t('AvailabilityScreen.adding')
                    : t('AvailabilityScreen.addWindow')}
                </Button>
              </div>
            </form>

            <section className="ppl-card ppl-card--tight" aria-labelledby="tm-availability-days">
              <h2 id="tm-availability-days" className="ppl-mono">
                {t('AvailabilityScreen.declaredDaysHeading')}
              </h2>
              <div className="ppl-metric">
                <span className="ppl-metric__value">{days.length - awayDays}</span>
                <span className="ppl-metric__label">
                  {t('AvailabilityScreen.ofPrefix')} {days.length}{' '}
                  {t('AvailabilityScreen.workingDays')}
                </span>
              </div>
              <p className="ppl-note">
                {awayDays === 0
                  ? t('AvailabilityScreen.noTimeOffTwoWeeks')
                  : `${awayDays} ${awayDays === 1 ? t('AvailabilityScreen.dayOne') : t('AvailabilityScreen.dayMany')} ${t('AvailabilityScreen.awayAsDeclared')}`}
              </p>
            </section>

            <section
              className="ppl-card ppl-card--tight ppl-card--ink"
              aria-labelledby="tm-availability-who"
            >
              <h2 id="tm-availability-who" className="ppl-mono">
                {t('AvailabilityScreen.whoSeesHeading')}
              </h2>
              <p className="ppl-note ppl-note--ink">{t('AvailabilityScreen.whoSeesBody')}</p>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function WeekHead({ week, gap }: { week: readonly string[]; gap: boolean }) {
  return (
    <>
      {gap ? <span className="ppl-grid__gap" aria-hidden="true" /> : null}
      <span className="ppl-grid__week">
        {week.map((day, index) => (
          <span key={day} className="ppl-grid__day-head" role="columnheader">
            {DAY_LETTERS[index]}
            <span>{Number(day.slice(8))}</span>
          </span>
        ))}
      </span>
    </>
  );
}

function WeekCells({
  week,
  gap,
  today,
  awayKind,
  t,
}: {
  week: readonly string[];
  gap: boolean;
  today: string;
  awayKind: (day: string) => string | undefined;
  t: ReturnType<typeof useT>;
}) {
  return (
    <>
      {gap ? <span className="ppl-grid__gap" aria-hidden="true" /> : null}
      <span className="ppl-grid__week">
        {week.map((day) => {
          const away = awayKind(day);
          const className =
            away !== undefined
              ? 'ppl-day ppl-day--away'
              : day === today
                ? 'ppl-day ppl-day--today'
                : 'ppl-day';
          return (
            <span key={day} className={className} role="cell">
              {away !== undefined ? t('AvailabilityScreen.awayCaps') : ''}
              <span className="tm-visually-hidden">
                {`${day}: ${away !== undefined ? `${t('AvailabilityScreen.awayLower')} (${kindLabel(t, away)})` : t('AvailabilityScreen.working')}`}
              </span>
            </span>
          );
        })}
      </span>
    </>
  );
}

function errorMessage(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return t('AvailabilityScreen.errorGeneric');
}
