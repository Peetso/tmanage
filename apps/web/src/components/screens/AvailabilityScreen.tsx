'use client';

import { useState } from 'react';
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

export interface AvailabilityScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The fixed vocabulary a window's kind may take — mirrors the API's `AVAILABILITY_KINDS`. */
const KINDS: readonly { value: string; label: string }[] = [
  { value: 'vacation', label: 'Vacation' },
  { value: 'sick', label: 'Sick' },
  { value: 'holiday', label: 'Holiday' },
  { value: 'personal', label: 'Personal' },
  { value: 'other', label: 'Other' },
];

/**
 * **Member availability / out-of-office (module 14 People & capacity, x218).**
 *
 * `38-MODULE-MAP` §People & capacity. The audit found capacity (hours) and quiet-hours (per-day time
 * window) built, but no way for a member to record that they are away between two dates. This is that
 * screen: the caller reads their own out-of-office windows, adds one (a start/end date, a kind, an
 * optional note), and removes one — persisted behind `work.read`, scoped to the caller's own
 * membership by the server.
 */
export function AvailabilityScreen({
  organizationSlug,
  organizationName,
  client,
}: AvailabilityScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const windows = useQuery({
    queryKey: ['availability', organizationSlug],
    queryFn: () => listOwnAvailability(api, organizationSlug),
  });

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [kind, setKind] = useState<string>(KINDS[0]!.value);
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
      setKind(KINDS[0]!.value);
      setNote('');
    },
  });

  const remove = useMutation({
    mutationFn: (id: string): Promise<void> => deleteAvailabilityWindow(api, organizationSlug, id),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['availability', organizationSlug] });
    },
  });

  const list = windows.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Availability"
      description="Record the dates you are out of office, so your team can see when you are away."
    >
      <form
        className="tm-panel tm-stack"
        aria-labelledby="tm-availability-add-heading"
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate();
        }}
      >
        <h2 id="tm-availability-add-heading" className="tm-eyebrow">
          Add an out-of-office window
        </h2>

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-availability-start">
            Start date
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
            End date
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

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-availability-kind">
            Kind
          </label>
          <select
            id="tm-availability-kind"
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
          <label className="tm-field__label" htmlFor="tm-availability-note">
            Note (optional)
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
          <InlineAlert tone="danger" title="We could not add the window">
            {errorMessage(add.error)}
          </InlineAlert>
        ) : null}

        <div>
          <Button type="submit" disabled={add.isPending}>
            {add.isPending ? 'Adding…' : 'Add window'}
          </Button>
        </div>
      </form>

      <section className="tm-panel tm-stack" aria-labelledby="tm-availability-list-heading">
        <h2 id="tm-availability-list-heading" className="tm-eyebrow">
          Your out-of-office windows
        </h2>

        {windows.isPending ? (
          <LoadingRegion label="Loading your availability">
            <Skeleton />
          </LoadingRegion>
        ) : windows.isError ? (
          <InlineAlert tone="danger" title="We could not load your availability">
            {errorMessage(windows.error)}
          </InlineAlert>
        ) : list.length === 0 ? (
          <p className="tm-muted">You have no out-of-office windows recorded.</p>
        ) : (
          <ul className="tm-list">
            {list.map((window) => (
              <li key={window.id} className="tm-list__item">
                <span>
                  {window.startDate} → {window.endDate} · {kindLabel(window.kind)}
                  {window.note ? ` · ${window.note}` : ''}
                </span>
                <Button
                  type="button"
                  tone="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(window.id)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        {remove.isError ? (
          <InlineAlert tone="danger" title="We could not remove the window">
            {errorMessage(remove.error)}
          </InlineAlert>
        ) : null}
      </section>
    </AppShell>
  );
}

function kindLabel(kind: string): string {
  return KINDS.find((entry) => entry.value === kind)?.label ?? kind;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
