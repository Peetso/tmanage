'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  MEETING_OCCURRENCE_OVERRIDE_STATUSES,
  getOccurrenceOverride,
  removeOccurrenceOverride,
  upsertOccurrenceOverride,
} from '../../lib/api/meeting-occurrence-override';
import type { MeetingOccurrenceOverrideStatus } from '../../lib/api/meeting-occurrence-override';
import { ApiRequestError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import '../../styles/screens/calendar.css';

export interface OccurrenceOverrideControlProps {
  organizationSlug: string;
  /** The series whose occurrence is being overridden. */
  seriesId: string;
  /** The original occurrence date (`YYYY-MM-DD`) this control decorates. */
  occurrenceDate: string;
  client?: ApiClient;
}

/** The message key for how each override kind reads in the picker. */
const STATUS_LABEL_KEYS: Record<MeetingOccurrenceOverrideStatus, MessageKey> = {
  moved: 'OccurrenceOverrideControl.statusMoved',
  cancelled: 'OccurrenceOverrideControl.statusCancelled',
};

/**
 * **CAL per-occurrence override — the occurrence edit control (x213).**
 *
 * A recurring series (x129) expands its occurrences on read; this control edits the *exception* for a
 * single occurrence date without disturbing the rule: cancel that one occurrence, or move it (a new
 * date, and optionally a new time or title). It is a distinct file from `MeetingSeriesScreen` (x129)
 * so a calendar grid or agenda (x127/x212) can mount it against whichever occupied cell the user
 * opens, passing the series and the original date.
 *
 * - **Reads the current override** for `(seriesId, occurrenceDate)` behind `meeting.read`; a 404 means
 *   there is no exception yet and the base rule applies.
 * - **Saving** → `POST .../occurrences/:date` behind `meeting.write`. A cancelled occurrence carries no
 *   move fields; a moved one carries at least one of a new date, time or title. A refusal is shown
 *   in place, the override untouched.
 * - **Clearing** → `DELETE .../occurrences/:date` behind `meeting.write`, restoring the base rule.
 */
export function OccurrenceOverrideControl({
  organizationSlug,
  seriesId,
  occurrenceDate,
  client,
}: OccurrenceOverrideControlProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const queries = useQueryClient();
  const queryKey = ['occurrence-override', organizationSlug, seriesId, occurrenceDate];

  const [status, setStatus] = useState<MeetingOccurrenceOverrideStatus>('moved');
  const [newDate, setNewDate] = useState('');
  const [newStartTime, setNewStartTime] = useState('');
  const [newTitle, setNewTitle] = useState('');

  const override = useQuery({
    queryKey,
    queryFn: async () => {
      try {
        return await getOccurrenceOverride(api, organizationSlug, seriesId, occurrenceDate);
      } catch (error) {
        // A 404 is the ordinary "no exception yet" state, not an error to surface.
        if (error instanceof ApiRequestError && error.status === 404) return null;
        throw error;
      }
    },
  });

  const moving = status === 'moved';
  const canSave = !moving || newDate !== '' || newStartTime !== '' || newTitle.trim() !== '';

  const save = useMutation({
    mutationFn: () =>
      upsertOccurrenceOverride(api, organizationSlug, seriesId, occurrenceDate, {
        status,
        ...(moving && newDate !== '' ? { newDate } : {}),
        ...(moving && newStartTime !== '' ? { newStartTime } : {}),
        ...(moving && newTitle.trim() !== '' ? { newTitle: newTitle.trim() } : {}),
      }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey });
    },
  });

  const clear = useMutation({
    mutationFn: () => removeOccurrenceOverride(api, organizationSlug, seriesId, occurrenceDate),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey });
    },
  });

  function submitSave(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    save.mutate();
  }

  return (
    <section className="tm-cal-card" aria-labelledby="tm-occurrence-override">
      <h2 id="tm-occurrence-override" className="tm-cal-eyebrow">
        {t('OccurrenceOverrideControl.override')} {occurrenceDate}
      </h2>

      {override.isPending ? (
        <LoadingRegion label={t('OccurrenceOverrideControl.loading')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {override.isError ? (
        <InlineAlert tone="danger" title={t('OccurrenceOverrideControl.loadError')} live>
          {describeError(override.error)}
        </InlineAlert>
      ) : null}

      {override.data ? (
        <InlineAlert
          tone="neutral"
          title={`${t('OccurrenceOverrideControl.thisOccurrenceIs')} ${t(STATUS_LABEL_KEYS[override.data.status])}`}
        >
          {override.data.status === 'moved'
            ? `${t('OccurrenceOverrideControl.movedTo')} ${override.data.newDate ?? occurrenceDate}${
                override.data.newStartTime
                  ? ` ${t('OccurrenceOverrideControl.at')} ${override.data.newStartTime}`
                  : ''
              }${override.data.newTitle ? ` — ${override.data.newTitle}` : ''}.`
            : t('OccurrenceOverrideControl.occurrenceCancelled')}
        </InlineAlert>
      ) : null}

      <form noValidate className="tm-cal-form" onSubmit={submitSave}>
        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-override-status">
            {t('OccurrenceOverrideControl.thisOccurrence')}
          </label>
          <select
            id="tm-override-status"
            className="tm-field__control"
            value={status}
            onChange={(event) => setStatus(event.target.value as MeetingOccurrenceOverrideStatus)}
          >
            {MEETING_OCCURRENCE_OVERRIDE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(STATUS_LABEL_KEYS[value])}
              </option>
            ))}
          </select>
        </div>

        {moving ? (
          <>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-override-date">
                {t('OccurrenceOverrideControl.newDate')}
              </label>
              <input
                id="tm-override-date"
                type="date"
                className="tm-field__control"
                value={newDate}
                onChange={(event) => setNewDate(event.target.value)}
              />
            </div>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-override-time">
                {t('OccurrenceOverrideControl.newTime')}
              </label>
              <input
                id="tm-override-time"
                type="time"
                className="tm-field__control"
                value={newStartTime}
                onChange={(event) => setNewStartTime(event.target.value)}
              />
            </div>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-override-title">
                {t('OccurrenceOverrideControl.newTitle')}
              </label>
              <input
                id="tm-override-title"
                className="tm-field__control"
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                maxLength={300}
              />
              <span className="tm-field__hint">{t('OccurrenceOverrideControl.moveNeeds')}</span>
            </div>
          </>
        ) : null}

        {save.isError ? (
          <InlineAlert tone="danger" title={t('OccurrenceOverrideControl.saveError')} live>
            {save.error instanceof ApiRequestError
              ? save.error.message
              : t('OccurrenceOverrideControl.apiNoAnswer')}
          </InlineAlert>
        ) : null}

        <div className="tm-cal-btn-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={save.isPending}
            loadingLabel={t('OccurrenceOverrideControl.saving')}
            disabled={!canSave}
          >
            {t('OccurrenceOverrideControl.saveOverride')}
          </Button>
          {override.data ? (
            <Button
              type="button"
              tone="outline"
              size="accessible"
              loading={clear.isPending}
              loadingLabel={t('OccurrenceOverrideControl.clearing')}
              onClick={() => clear.mutate()}
            >
              {t('OccurrenceOverrideControl.clearOverride')}
            </Button>
          ) : null}
        </div>

        {clear.isError ? (
          <InlineAlert tone="danger" title={t('OccurrenceOverrideControl.clearError')} live>
            {describeError(clear.error)}
          </InlineAlert>
        ) : null}
      </form>
    </section>
  );
}
