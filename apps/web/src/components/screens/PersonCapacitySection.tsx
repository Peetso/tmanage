'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { getPersonCapacity, setPersonCapacity } from '../../lib/api/person-capacity';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface PersonCapacitySectionProps {
  organizationSlug: string;
  membershipId: string;
  client?: ApiClient | undefined;
}

const MAX_WEEKLY_HOURS = 168;

/**
 * **People capacity (module 14, x170)** — the capacity editor on a member's profile, additive and
 * disjoint from the x169 profile file.
 *
 * A faithful reader of the API's per-member capacity: it reads `GET .../people/:membershipId/capacity`
 * (behind `work.read`) and lets a manager set the weekly hours and effective date with
 * `PUT …/capacity` (behind `project.manage`). The section is its own landmark (`aria-labelledby`) with
 * real `<label>`s (the `Field` component) and a submit-path `InlineAlert`, so it is axe-clean the way
 * the sibling sections are. Client-side it mirrors the server's [0,168] bound; the server is the
 * authority and its 400 is surfaced through the alert.
 */
export function PersonCapacitySection({
  organizationSlug,
  membershipId,
  client,
}: PersonCapacitySectionProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['people', 'capacity', organizationSlug, membershipId];

  const capacity = useQuery({
    queryKey,
    queryFn: () => getPersonCapacity(api, organizationSlug, membershipId),
  });

  const [weeklyHours, setWeeklyHours] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');

  // Seed the form from the loaded figure once, without clobbering an in-progress edit.
  useEffect(() => {
    if (capacity.data) {
      setWeeklyHours(String(capacity.data.weeklyHours));
      setEffectiveFrom(capacity.data.effectiveFrom);
    }
  }, [capacity.data]);

  const hours = Number(weeklyHours);
  const hoursValid =
    weeklyHours !== '' && Number.isInteger(hours) && hours >= 0 && hours <= MAX_WEEKLY_HOURS;
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom);
  const canSave = hoursValid && dateValid;

  const save = useMutation({
    mutationFn: () =>
      setPersonCapacity(api, organizationSlug, membershipId, {
        weeklyHours: hours,
        effectiveFrom,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-person-capacity-heading">
      <h2 id="tm-person-capacity-heading" className="tm-eyebrow">
        Weekly capacity
      </h2>

      {capacity.isError ? (
        <InlineAlert tone="danger" title="Could not load this member's capacity" live>
          {describeError(capacity.error)}
        </InlineAlert>
      ) : null}

      {capacity.isPending ? (
        <LoadingRegion label="Loading capacity.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!capacity.isPending && !capacity.isError && capacity.data === null ? (
        <InlineAlert tone="neutral" title="No capacity set yet">
          Set how many hours a week this member is available. Allocation reads against this figure.
        </InlineAlert>
      ) : null}

      {save.isError ? (
        <InlineAlert tone="danger" title="Could not save capacity" live>
          {describeError(save.error)}
        </InlineAlert>
      ) : null}

      {save.isSuccess ? (
        <InlineAlert tone="success" title="Capacity saved" live>
          This member's weekly capacity has been updated.
        </InlineAlert>
      ) : null}

      <form
        className="tm-stack"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        <Field
          label="Hours a week"
          name="weeklyHours"
          type="number"
          min={0}
          max={MAX_WEEKLY_HOURS}
          step={1}
          inputMode="numeric"
          value={weeklyHours}
          onChange={(event) => setWeeklyHours(event.target.value)}
          hint="A whole number of hours, 0 to 168."
          error={
            weeklyHours !== '' && !hoursValid
              ? 'Enter a whole number between 0 and 168.'
              : undefined
          }
          required
        />

        <Field
          label="Effective from"
          name="effectiveFrom"
          type="date"
          value={effectiveFrom}
          onChange={(event) => setEffectiveFrom(event.target.value)}
          hint="The day this figure takes effect."
          error={effectiveFrom !== '' && !dateValid ? 'Enter a valid date.' : undefined}
          required
        />

        <div className="tm-row">
          <Button type="submit" disabled={!canSave} loading={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save capacity'}
          </Button>
        </div>
      </form>
    </section>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped. Check your connection and retry.';
  return 'Something went wrong. Retry in a moment.';
}
