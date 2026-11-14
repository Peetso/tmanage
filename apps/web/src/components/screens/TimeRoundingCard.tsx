'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_ROUNDING_MINUTES,
  NO_ROUNDING_MINUTES,
  TIME_ROUNDING_CHOICES,
  isTimeRoundingChoice,
  roundingIncrement,
  type TimeRoundingChoice,
} from '@tmanage/domain';
import { Button, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { updateTimeRounding } from '../../lib/api/time-timer';
import { pluralPhrase } from '../../lib/i18n/plural';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import { timerKey, timerQuery } from '../time/use-running-timer';
import './download-scan-policy.css';

export interface TimeRoundingCardProps {
  readonly organizationSlug: string;
  readonly client: ApiClient;
  /** Only the company owner may change the step; admins read it. */
  readonly isOwner: boolean;
}

/** A stored step read as one the owner can choose (`0` is "no rounding" too). */
function choiceOf(stored: number | undefined): TimeRoundingChoice {
  const step = roundingIncrement(stored);
  if (step <= NO_ROUNDING_MINUTES) return NO_ROUNDING_MINUTES;
  return isTimeRoundingChoice(step) ? step : DEFAULT_ROUNDING_MINUTES;
}

/**
 * 52-01 — the owner's rounding step for the manual timer, in the company's time settings beside
 * the automatic-timer policy. Same shape as that card: a choice, Save and Cancel, owner only; the
 * API checks the owner and writes the audit row. The step is read from the timer read every timer
 * surface shares, so a saved change reaches the Stop dialog at once.
 */
export function TimeRoundingCard({ organizationSlug, client, isOwner }: TimeRoundingCardProps) {
  const tr = useTOr();
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const titleId = useId();
  const current = useQuery(timerQuery(client, organizationSlug));
  const stored = choiceOf(current.data?.state?.roundingMinutes);
  const [draft, setDraft] = useState<TimeRoundingChoice | null>(null);
  const [saved, setSaved] = useState(false);
  const value = draft ?? stored;

  const save = useMutation({
    mutationFn: (next: TimeRoundingChoice) => updateTimeRounding(client, organizationSlug, next),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: timerKey(organizationSlug) });
      setDraft(null);
      setSaved(true);
    },
  });

  const cancel = () => {
    setDraft(null);
    setSaved(false);
    save.reset();
  };

  const label = (step: TimeRoundingChoice): string => {
    if (step === NO_ROUNDING_MINUTES) return tr('TimeRounding.none', 'No rounding (exact minutes)');
    const minutes = pluralPhrase(tr, locale, 'TimeRounding.stepMinutes', step, {
      one: '{count} minute',
      other: '{count} minutes',
    });
    return step === DEFAULT_ROUNDING_MINUTES
      ? `${minutes} ${tr('TimeRounding.defaultSuffix', '(default)')}`
      : minutes;
  };

  return (
    <section className="tm-dlscan" aria-labelledby={titleId}>
      <h2 id={titleId} className="tm-dlscan__title">
        {tr('TimeRounding.title', 'Timer rounding')}
      </h2>
      <p className="tm-dlscan__intro">
        {tr(
          'TimeRounding.intro',
          'When someone stops the manual timer, the time is rounded up to this step before it is saved. Automatic time is never rounded.',
        )}
      </p>

      {current.isError ? (
        <InlineAlert tone="danger" live>
          {tr('TimeRounding.loadError', 'The setting could not be loaded.')}
        </InlineAlert>
      ) : current.isPending ? (
        <LoadingRegion label={tr('TimeRounding.title', 'Timer rounding')}>
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : (
        <>
          <Select
            label={tr('TimeRounding.label', 'Round timer time up to')}
            hint={tr(
              'TimeRounding.hint',
              'Applies to time saved from now on. Entries already saved keep their minutes.',
            )}
            value={String(value)}
            disabled={!isOwner || save.isPending}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!isTimeRoundingChoice(next)) return;
              setSaved(false);
              setDraft(next);
            }}
          >
            {TIME_ROUNDING_CHOICES.map((step) => (
              <option key={step} value={step}>
                {label(step)}
              </option>
            ))}
          </Select>

          {isOwner ? (
            <>
              {save.isError ? (
                <InlineAlert tone="danger" live>
                  {tr('TimeRounding.saveError', 'The setting was not saved. Try again.')}
                </InlineAlert>
              ) : null}
              {saved && draft === null ? (
                <InlineAlert tone="success" live>
                  {tr('TimeRounding.saved', 'Saved.')}
                </InlineAlert>
              ) : null}
              <hr className="tm-dlscan__rule" />
              <div className="tm-dlscan__footer">
                <Button
                  type="button"
                  tone="outline"
                  onClick={cancel}
                  disabled={save.isPending || draft === null}
                >
                  {tr('TimeRounding.cancel', 'Cancel')}
                </Button>
                <Button
                  type="button"
                  tone="ink"
                  loading={save.isPending}
                  loadingLabel={tr('TimeRounding.saving', 'Saving')}
                  disabled={draft === null || draft === stored}
                  onClick={() => save.mutate(value)}
                >
                  {tr('TimeRounding.save', 'Save')}
                </Button>
              </div>
            </>
          ) : (
            <InlineAlert tone="neutral">
              {tr('TimeRounding.ownerOnly', 'Only the company owner can change this.')}
            </InlineAlert>
          )}
        </>
      )}
    </section>
  );
}
