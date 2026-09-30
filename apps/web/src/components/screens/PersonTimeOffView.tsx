'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createPersonTimeOff,
  deletePersonTimeOff,
  listPersonTimeOff,
} from '../../lib/api/person-time-off';
import type {
  PersonTimeOffRange,
  PersonTimeOffView as TimeOffEntry,
} from '../../lib/api/person-time-off';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface PersonTimeOffViewProps {
  organizationSlug: string;
  /** The person whose time-off this panel manages — their global user id. */
  userId: string;
  /** Whether the viewer may file/remove entries (holds `org.manage`); controls the add form. */
  canManage?: boolean;
  client?: ApiClient;
}

/** The fixed vocabulary an entry's kind may take — mirrors the API's `TIME_OFF_KINDS`. */
const KINDS: readonly { value: string; label: string }[] = [
  { value: 'vacation', label: 'Vacation' },
  { value: 'sick', label: 'Sick' },
  { value: 'other', label: 'Other' },
];

/** A range chip's key; `all` clears the `?from&to` window. */
type RangeChip = 'all' | 'next30' | 'next90';

const CHIPS: readonly { key: RangeChip; label: string; days: number | null }[] = [
  { key: 'all', label: 'All', days: null },
  { key: 'next30', label: 'Next 30 days', days: 30 },
  { key: 'next90', label: 'Next 90 days', days: 90 },
];

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * **Person time-off (module 14 People & capacity, x325).**
 *
 * `38-MODULE-MAP` §People & capacity (time off / PTO); `22-SCREEN` §Person detail. A manager's panel on
 * the person-detail screen: the person's recorded absences (start/end date, kind, optional note), a
 * form to file a new one, and range chips that scope the list to an upcoming window. Stored records
 * only — no approval workflow. Persisted behind `org.manage` (write) / `work.read` (read) on the
 * server, scoped to a membership of this studio resolved from the person's user id.
 */
export function PersonTimeOffView({
  organizationSlug,
  userId,
  canManage = false,
  client,
}: PersonTimeOffViewProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [chip, setChip] = useState<RangeChip>('all');

  const range = useMemo<PersonTimeOffRange | undefined>(() => {
    const preset = CHIPS.find((entry) => entry.key === chip);
    if (!preset || preset.days === null) return undefined;
    const from = new Date();
    const to = new Date();
    to.setDate(to.getDate() + preset.days);
    return { from: isoDate(from), to: isoDate(to) };
  }, [chip]);

  const entries = useQuery({
    queryKey: ['person-time-off', organizationSlug, userId, chip],
    queryFn: () => listPersonTimeOff(api, organizationSlug, userId, range),
  });

  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [kind, setKind] = useState<string>(KINDS[0]!.value);
  const [note, setNote] = useState('');

  const invalidate = () =>
    void queries.invalidateQueries({ queryKey: ['person-time-off', organizationSlug, userId] });

  const add = useMutation({
    mutationFn: (): Promise<TimeOffEntry> =>
      createPersonTimeOff(api, organizationSlug, userId, {
        startsOn,
        endsOn,
        kind,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: () => {
      invalidate();
      setStartsOn('');
      setEndsOn('');
      setKind(KINDS[0]!.value);
      setNote('');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string): Promise<void> =>
      deletePersonTimeOff(api, organizationSlug, userId, id),
    onSuccess: invalidate,
  });

  const list = entries.data ?? [];

  return (
    <section className="tm-stack" aria-labelledby="tm-time-off-heading">
      <h2 id="tm-time-off-heading" className="tm-eyebrow">
        Time off
      </h2>

      {canManage ? (
        <form
          className="tm-panel tm-stack"
          aria-labelledby="tm-time-off-add-heading"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <h3 id="tm-time-off-add-heading" className="tm-eyebrow">
            Record time off
          </h3>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-time-off-start">
              Start date
            </label>
            <input
              id="tm-time-off-start"
              className="tm-field__control"
              type="date"
              value={startsOn}
              required
              onChange={(event) => setStartsOn(event.target.value)}
            />
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-time-off-end">
              End date
            </label>
            <input
              id="tm-time-off-end"
              className="tm-field__control"
              type="date"
              value={endsOn}
              required
              onChange={(event) => setEndsOn(event.target.value)}
            />
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-time-off-kind">
              Kind
            </label>
            <select
              id="tm-time-off-kind"
              className="tm-field__control"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              {KINDS.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-time-off-note">
              Note (optional)
            </label>
            <input
              id="tm-time-off-note"
              className="tm-field__control"
              type="text"
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          {add.isError ? (
            <InlineAlert tone="danger" title="We could not record the time off">
              {errorMessage(add.error)}
            </InlineAlert>
          ) : null}

          <div>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? 'Recording…' : 'Record time off'}
            </Button>
          </div>
        </form>
      ) : null}

      <div className="tm-panel tm-stack" aria-labelledby="tm-time-off-list-heading">
        <h3 id="tm-time-off-list-heading" className="tm-eyebrow">
          Recorded time off
        </h3>

        <div className="tm-button-row" role="group" aria-label="Filter time off by range">
          {CHIPS.map((entry) => (
            <Button
              key={entry.key}
              type="button"
              tone={chip === entry.key ? 'lime' : 'outline'}
              aria-pressed={chip === entry.key}
              onClick={() => setChip(entry.key)}
            >
              {entry.label}
            </Button>
          ))}
        </div>

        {entries.isPending ? (
          <LoadingRegion label="Loading time off">
            <Skeleton />
          </LoadingRegion>
        ) : entries.isError ? (
          <InlineAlert tone="danger" title="We could not load the time off">
            {errorMessage(entries.error)}
          </InlineAlert>
        ) : list.length === 0 ? (
          <p className="tm-muted">No time off recorded for this range.</p>
        ) : (
          <ul className="tm-list">
            {list.map((entry) => (
              <li key={entry.id} className="tm-list__item">
                <span>
                  {entry.startsOn} → {entry.endsOn} · {kindLabel(entry.kind)}
                  {entry.note ? ` · ${entry.note}` : ''}
                </span>
                {canManage ? (
                  <Button
                    type="button"
                    tone="destructive"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(entry.id)}
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {remove.isError ? (
          <InlineAlert tone="danger" title="We could not remove the entry">
            {errorMessage(remove.error)}
          </InlineAlert>
        ) : null}
      </div>
    </section>
  );
}

function kindLabel(kind: string): string {
  return KINDS.find((entry) => entry.value === kind)?.label ?? kind;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
