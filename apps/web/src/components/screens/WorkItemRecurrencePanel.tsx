'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Field,
  InlineAlert,
  LoadingRegion,
  Radio,
  RadioGroup,
  Select,
  Skeleton,
} from '@tmanage/ui';
import {
  clearWorkItemRecurrence,
  getWorkItemRecurrence,
  previewRecurrenceDraft,
  saveRecurrenceRule,
  setRecurrencePaused,
} from '../../lib/api/work-item-recurrence';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { appIntlLocale } from '../../lib/i18n/app-locale';
import {
  WEEKDAY_TOKENS,
  draftErrors,
  draftOf,
  inputOf,
  type HolidayPolicy,
  type RecurrenceDraft,
  type WeekdayToken,
} from './recurrence-draft';
import '../../styles/screens/r46-repeat-contacts.css';

export interface WorkItemRecurrencePanelProps {
  organizationSlug: string;
  workItemId: string;
  api: ApiClient;
  /** Today as an ISO date; injected by tests. */
  today?: string;
}

/** Sunday 2026-11-01 + n days: a fixed week to name weekdays in the active locale. */
function weekdayName(token: WeekdayToken, style: 'narrow' | 'long'): string {
  const day = WEEKDAY_TOKENS.indexOf(token);
  return new Date(Date.UTC(2026, 10, 1 + day)).toLocaleDateString(appIntlLocale(), {
    weekday: style,
    timeZone: 'UTC',
  });
}

function formatDay(iso: string): string {
  const at = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString(appIntlLocale(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const NTH_POSITIONS = [1, 2, 3, 4, -1] as const;

/**
 * **53-09 · the repeat rules editor** on a work item (Figma 587:33551 EN / 587:33650 AR).
 *
 * Every N days / weeks / months; weekdays for a weekly rule; a month day (31 lands on the last day
 * of a shorter month) or the nth weekday for a monthly rule; end never / after N times / on a date;
 * what to do on holidays of the company calendar; how many days ahead the task is created; pause /
 * resume; and, when a saved rule is edited, whether the change applies to this and future dates or
 * to the whole series. The next 5 dates are previewed live from the server (the same calendar the
 * spawner uses) before anything is saved. Behind `work.read` to view, `work.update` to change.
 */
export function WorkItemRecurrencePanel({
  organizationSlug,
  workItemId,
  api,
  today = new Date().toISOString().slice(0, 10),
}: WorkItemRecurrencePanelProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const tOr = useTOr();
  const queries = useQueryClient();
  const queryKey = ['work-item-recurrence', organizationSlug, workItemId] as const;
  const [draft, setDraft] = useState<RecurrenceDraft>(() => draftOf(null, today));
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const set = (patch: Partial<RecurrenceDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const rule = useQuery({
    queryKey,
    queryFn: () => getWorkItemRecurrence(api, organizationSlug, workItemId),
  });

  useEffect(() => {
    if (rule.data !== undefined) setDraft(draftOf(rule.data, today));
  }, [rule.data, today]);

  const hasRule = Boolean(rule.data);
  const status = rule.data?.status ?? 'active';
  const errors = draftErrors(draft);
  const input = useMemo(() => inputOf(draft, hasRule), [draft, hasRule]);
  const settled = useDebounced(input, 300);

  const preview = useQuery({
    queryKey: ['work-item-recurrence-draft', organizationSlug, workItemId, settled],
    queryFn: () => previewRecurrenceDraft(api, organizationSlug, workItemId, settled!),
    enabled: settled !== null && rule.data !== undefined,
    retry: false,
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }
  const onError = (error: unknown) => setFailure(describe(error));
  const onDone = () => {
    setFailure(undefined);
    refresh();
  };

  const save = useMutation({
    mutationFn: () => saveRecurrenceRule(api, organizationSlug, workItemId, input!),
    onSuccess: onDone,
    onError,
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) => setRecurrencePaused(api, organizationSlug, workItemId, paused),
    onSuccess: onDone,
    onError,
  });
  const clear = useMutation({
    mutationFn: () => clearWorkItemRecurrence(api, organizationSlug, workItemId),
    onSuccess: onDone,
    onError,
  });
  const pending = save.isPending || pause.isPending || clear.isPending;

  const unitLabel = {
    DAILY: tOr('WorkItemRecurrencePanel.unitDays', 'Days'),
    WEEKLY: tOr('WorkItemRecurrencePanel.unitWeeks', 'Weeks'),
    MONTHLY: tOr('WorkItemRecurrencePanel.unitMonths', 'Months'),
  } as const;
  const statusLabel =
    status === 'paused'
      ? tOr('WorkItemRecurrencePanel.statusPaused', 'Paused')
      : status === 'ended'
        ? tOr('WorkItemRecurrencePanel.statusEnded', 'Ended')
        : tOr('WorkItemRecurrencePanel.statusActive', 'Active');
  const nthLabel = (pos: number) =>
    pos === -1
      ? tOr('WorkItemRecurrencePanel.nthLast', 'Last')
      : [
          tOr('WorkItemRecurrencePanel.nthFirst', 'First'),
          tOr('WorkItemRecurrencePanel.nthSecond', 'Second'),
          tOr('WorkItemRecurrencePanel.nthThird', 'Third'),
          tOr('WorkItemRecurrencePanel.nthFourth', 'Fourth'),
        ][pos - 1];

  return (
    <section className="tm-r46-card" aria-labelledby="tm-work-recurrence">
      <div className="tm-r46-head">
        <h2 id="tm-work-recurrence" className="tm-eyebrow">
          {t('WorkItemRecurrencePanel.heading')}
        </h2>
        {hasRule ? <Badge>{statusLabel}</Badge> : null}
      </div>

      {rule.isPending ? (
        <LoadingRegion label={t('WorkItemRecurrencePanel.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {rule.isError ? (
        <InlineAlert tone="danger" title={t('WorkItemRecurrencePanel.loadError')} live>
          {describe(rule.error)}
        </InlineAlert>
      ) : null}

      {rule.data !== undefined ? (
        <form
          className="tm-r46-group"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (input && !pending) save.mutate();
          }}
        >
          <div className="tm-r46-row">
            <Field
              label={tOr('WorkItemRecurrencePanel.every', 'Every')}
              name="interval"
              type="number"
              inputMode="numeric"
              min={1}
              max={52}
              value={draft.interval}
              onChange={(event) => set({ interval: event.target.value })}
              error={
                errors.interval
                  ? tOr(
                      'WorkItemRecurrencePanel.intervalRange',
                      'Enter a whole number from 1 to 52.',
                    )
                  : undefined
              }
            />
            <Select
              label={tOr('WorkItemRecurrencePanel.unit', 'Unit')}
              value={draft.freq}
              onChange={(event) => set({ freq: event.target.value as RecurrenceDraft['freq'] })}
            >
              {(['DAILY', 'WEEKLY', 'MONTHLY'] as const).map((freq) => (
                <option key={freq} value={freq}>
                  {unitLabel[freq]}
                </option>
              ))}
            </Select>
          </div>

          {draft.freq === 'WEEKLY' ? (
            <div className="tm-r46-group" role="group" aria-labelledby="tm-r46-days">
              <p className="tm-r46-label" id="tm-r46-days">
                {tOr('WorkItemRecurrencePanel.onDays', 'On these days')}
              </p>
              <div className="tm-r46-days">
                {WEEKDAY_TOKENS.map((token) => {
                  const on = draft.weekdays.includes(token);
                  return (
                    <button
                      key={token}
                      type="button"
                      className="tm-r46-day"
                      aria-pressed={on}
                      aria-label={weekdayName(token, 'long')}
                      onClick={() =>
                        set({
                          weekdays: on
                            ? draft.weekdays.filter((d) => d !== token)
                            : [...draft.weekdays, token],
                        })
                      }
                    >
                      {weekdayName(token, 'narrow')}
                    </button>
                  );
                })}
              </div>
              {errors.weekdays ? (
                <p className="tm-choice__error">
                  {tOr('WorkItemRecurrencePanel.pickDay', 'Pick at least one day.')}
                </p>
              ) : null}
            </div>
          ) : null}

          {draft.freq === 'MONTHLY' ? (
            <RadioGroup legend={tOr('WorkItemRecurrencePanel.monthlyOn', 'Monthly on')}>
              <Radio
                label={tOr('WorkItemRecurrencePanel.monthDay', 'A day of the month')}
                hint={tOr(
                  'WorkItemRecurrencePanel.monthDayHint',
                  'Day 31 lands on the last day in shorter months.',
                )}
                value="day"
                checked={draft.monthlyMode === 'day'}
                onChange={() => set({ monthlyMode: 'day' })}
              />
              {draft.monthlyMode === 'day' ? (
                <Field
                  label={tOr('WorkItemRecurrencePanel.day', 'Day')}
                  name="monthDay"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={31}
                  value={draft.monthDay}
                  onChange={(event) => set({ monthDay: event.target.value })}
                  error={
                    errors.monthDay
                      ? tOr('WorkItemRecurrencePanel.dayRange', 'Enter a day from 1 to 31.')
                      : undefined
                  }
                />
              ) : null}
              <Radio
                label={tOr('WorkItemRecurrencePanel.nthWeekday', 'A weekday of the month')}
                value="nth"
                checked={draft.monthlyMode === 'nth'}
                onChange={() => set({ monthlyMode: 'nth' })}
              />
              {draft.monthlyMode === 'nth' ? (
                <div className="tm-r46-row">
                  <Select
                    label={tOr('WorkItemRecurrencePanel.which', 'Which')}
                    value={String(draft.nthPos)}
                    onChange={(event) => set({ nthPos: Number(event.target.value) })}
                  >
                    {NTH_POSITIONS.map((pos) => (
                      <option key={pos} value={pos}>
                        {nthLabel(pos)}
                      </option>
                    ))}
                  </Select>
                  <Select
                    label={tOr('WorkItemRecurrencePanel.weekday', 'Weekday')}
                    value={draft.nthDay}
                    onChange={(event) => set({ nthDay: event.target.value as WeekdayToken })}
                  >
                    {WEEKDAY_TOKENS.map((token) => (
                      <option key={token} value={token}>
                        {weekdayName(token, 'long')}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
            </RadioGroup>
          ) : null}

          <RadioGroup legend={tOr('WorkItemRecurrencePanel.ends', 'Ends')}>
            <Radio
              label={tOr('WorkItemRecurrencePanel.endsNever', 'Never')}
              value="never"
              checked={draft.endMode === 'never'}
              onChange={() => set({ endMode: 'never' })}
            />
            <Radio
              label={tOr('WorkItemRecurrencePanel.endsAfter', 'After a number of times')}
              value="count"
              checked={draft.endMode === 'count'}
              onChange={() => set({ endMode: 'count' })}
            />
            {draft.endMode === 'count' ? (
              <Field
                label={tOr('WorkItemRecurrencePanel.times', 'Times')}
                name="count"
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                value={draft.count}
                onChange={(event) => set({ count: event.target.value })}
                error={
                  errors.count
                    ? tOr('WorkItemRecurrencePanel.countRange', 'Enter a number from 1 to 365.')
                    : undefined
                }
              />
            ) : null}
            <Radio
              label={tOr('WorkItemRecurrencePanel.endsOn', 'On a date')}
              value="date"
              checked={draft.endMode === 'date'}
              onChange={() => set({ endMode: 'date' })}
            />
            {draft.endMode === 'date' ? (
              <Field
                label={tOr('WorkItemRecurrencePanel.endDate', 'End date')}
                name="endsOn"
                type="date"
                value={draft.endsOn}
                onChange={(event) => set({ endsOn: event.target.value })}
                error={
                  errors.endsOn
                    ? tOr('WorkItemRecurrencePanel.endDateMissing', 'Choose the last date.')
                    : undefined
                }
              />
            ) : null}
          </RadioGroup>

          <Select
            label={tOr('WorkItemRecurrencePanel.holidays', 'On holidays and days off')}
            value={draft.holidayPolicy}
            onChange={(event) => set({ holidayPolicy: event.target.value as HolidayPolicy })}
          >
            <option value="next_working_day">
              {tOr('WorkItemRecurrencePanel.holidayMove', 'Move to the next working day')}
            </option>
            <option value="skip">
              {tOr('WorkItemRecurrencePanel.holidaySkip', 'Skip that date')}
            </option>
            <option value="keep">
              {tOr('WorkItemRecurrencePanel.holidayKeep', 'Keep the date anyway')}
            </option>
          </Select>

          <Field
            label={tOr(
              'WorkItemRecurrencePanel.createAhead',
              'Create the task this many days before',
            )}
            name="spawnAheadDays"
            type="number"
            inputMode="numeric"
            min={0}
            max={30}
            value={draft.spawnAheadDays}
            onChange={(event) => set({ spawnAheadDays: event.target.value })}
            error={
              errors.spawnAheadDays
                ? tOr('WorkItemRecurrencePanel.aheadRange', 'Enter a number from 0 to 30.')
                : undefined
            }
          />

          {hasRule ? (
            <RadioGroup legend={tOr('WorkItemRecurrencePanel.applyTo', 'Apply changes to')}>
              <Radio
                label={tOr('WorkItemRecurrencePanel.thisAndFuture', 'This and future occurrences')}
                value="this_and_future"
                checked={draft.scope === 'this_and_future'}
                onChange={() => set({ scope: 'this_and_future' })}
              />
              <Radio
                label={tOr('WorkItemRecurrencePanel.allOccurrences', 'All occurrences')}
                value="all"
                checked={draft.scope === 'all'}
                onChange={() => set({ scope: 'all' })}
              />
            </RadioGroup>
          ) : null}

          <div className="tm-r46-group" aria-live="polite">
            <p className="tm-r46-label" id="tm-r46-next">
              {tOr('WorkItemRecurrencePanel.next5', 'Next 5 dates')}
            </p>
            {preview.data && preview.data.occurrences.length > 0 ? (
              <ol className="tm-r46-preview" aria-labelledby="tm-r46-next">
                {preview.data.occurrences.map((o) => (
                  <li key={o.key}>
                    <span>{formatDay(o.date)}</span>
                    {o.date !== o.key ? (
                      <Badge>{tOr('WorkItemRecurrencePanel.movedHoliday', 'Moved: holiday')}</Badge>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : preview.isError ? (
              <p className="tm-r46-lede">{describe(preview.error)}</p>
            ) : preview.data ? (
              <p className="tm-r46-lede">{t('WorkItemRecurrencePanel.ruleEnded')}</p>
            ) : null}
          </div>

          {failure ? (
            <InlineAlert tone="danger" title={t('WorkItemRecurrencePanel.failureTitle')} live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-r46-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={save.isPending}
              loadingLabel={t('WorkItemRecurrencePanel.saving')}
              disabled={input === null || pending}
            >
              {tOr('WorkItemRecurrencePanel.save', 'Save')}
            </Button>
            {hasRule && status !== 'ended' ? (
              <Button
                type="button"
                tone="outline"
                size="accessible"
                disabled={pending}
                onClick={() => pause.mutate(status !== 'paused')}
              >
                {status === 'paused'
                  ? tOr('WorkItemRecurrencePanel.resume', 'Resume')
                  : tOr('WorkItemRecurrencePanel.pause', 'Pause')}
              </Button>
            ) : null}
            {hasRule ? (
              <Button
                type="button"
                tone="text"
                size="accessible"
                loading={clear.isPending}
                loadingLabel={t('WorkItemRecurrencePanel.clearing')}
                disabled={pending}
                onClick={() => clear.mutate()}
              >
                {tOr('WorkItemRecurrencePanel.stop', 'Stop repeating')}
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      {rule.data === null ? (
        <p className="tm-r46-lede">{t('WorkItemRecurrencePanel.doesNotRepeat')}</p>
      ) : null}
    </section>
  );
}
