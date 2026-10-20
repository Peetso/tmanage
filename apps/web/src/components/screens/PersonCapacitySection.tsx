'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { getPersonCapacity, setPersonCapacity } from '../../lib/api/person-capacity';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

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
  const t = useT();
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
        {t('PersonCapacitySection.heading')}
      </h2>

      {capacity.isError ? (
        <InlineAlert tone="danger" title={t('PersonCapacitySection.loadErrorTitle')} live>
          {describeError(capacity.error)}
        </InlineAlert>
      ) : null}

      {capacity.isPending ? (
        <LoadingRegion label={t('PersonCapacitySection.loading')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!capacity.isPending && !capacity.isError && capacity.data === null ? (
        <InlineAlert tone="neutral" title={t('PersonCapacitySection.emptyTitle')}>
          {t('PersonCapacitySection.emptyBody')}
        </InlineAlert>
      ) : null}

      {save.isError ? (
        <InlineAlert tone="danger" title={t('PersonCapacitySection.saveErrorTitle')} live>
          {describeError(save.error)}
        </InlineAlert>
      ) : null}

      {save.isSuccess ? (
        <InlineAlert tone="success" title={t('PersonCapacitySection.savedTitle')} live>
          {t('PersonCapacitySection.savedBody')}
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
          label={t('PersonCapacitySection.hoursLabel')}
          name="weeklyHours"
          type="number"
          min={0}
          max={MAX_WEEKLY_HOURS}
          step={1}
          inputMode="numeric"
          value={weeklyHours}
          onChange={(event) => setWeeklyHours(event.target.value)}
          hint={t('PersonCapacitySection.hoursHint')}
          error={
            weeklyHours !== '' && !hoursValid ? t('PersonCapacitySection.hoursError') : undefined
          }
          required
        />

        <Field
          label={t('PersonCapacitySection.effectiveLabel')}
          name="effectiveFrom"
          type="date"
          value={effectiveFrom}
          onChange={(event) => setEffectiveFrom(event.target.value)}
          hint={t('PersonCapacitySection.effectiveHint')}
          error={
            effectiveFrom !== '' && !dateValid ? t('PersonCapacitySection.dateError') : undefined
          }
          required
        />

        <div className="tm-row">
          <Button type="submit" disabled={!canSave} loading={save.isPending}>
            {save.isPending ? t('PersonCapacitySection.saving') : t('PersonCapacitySection.save')}
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
