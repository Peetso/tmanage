'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AUTO_TRACKING_POLICIES, type AutoTrackingPolicy } from '@tmanage/domain';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { getAutoTracking, updateAutoTrackingPolicy } from '../../lib/api/time-auto';
import type { AutoTrackingState } from '../../lib/api/time-auto';
import { useTOr } from '../../lib/i18n/use-t-or';
import { autoTrackingKey } from '../time/use-auto-tracker';
import './download-scan-policy.css';

export interface AutoTimePolicyCardProps {
  readonly organizationSlug: string;
  readonly client: ApiClient;
  /** Only the company owner may change the choice; admins read it. */
  readonly isOwner: boolean;
}

const CHOICES: Readonly<
  Record<
    AutoTrackingPolicy,
    { readonly label: readonly [string, string]; readonly hint: readonly [string, string] }
  >
> = {
  off: {
    label: ['AutoTimePolicy.offLabel', 'Off'],
    hint: [
      'AutoTimePolicy.offHint',
      'Nobody in the company uses the automatic timer. The manual timer stays.',
    ],
  },
  optional: {
    label: ['AutoTimePolicy.optionalLabel', 'Each person chooses'],
    hint: [
      'AutoTimePolicy.optionalHint',
      'People turn "Track my time automatically" on or off for themselves.',
    ],
  },
  required: {
    label: ['AutoTimePolicy.requiredLabel', 'On for everyone'],
    hint: [
      'AutoTimePolicy.requiredHint',
      'Automatic tracking is on for every person and they cannot turn it off. They still choose their idle time.',
    ],
  },
};

/**
 * FIX-2026-11-10 — the owner's company policy for the automatic timer (off / optional / required).
 * Same shape as the download-scan policy card: option cards, Save and Cancel, owner-only; the API
 * checks the owner and writes the audit row.
 */
export function AutoTimePolicyCard({ organizationSlug, client, isOwner }: AutoTimePolicyCardProps) {
  const tr = useTOr();
  const queryClient = useQueryClient();
  const titleId = useId();
  const name = useId();
  const key = autoTrackingKey(organizationSlug);
  const current = useQuery({
    queryKey: key,
    queryFn: () => getAutoTracking(client, organizationSlug),
    retry: false,
  });
  const stored = current.data?.policy ?? 'optional';
  const [draft, setDraft] = useState<AutoTrackingPolicy | null>(null);
  const [saved, setSaved] = useState(false);
  const value = draft ?? stored;

  const save = useMutation({
    mutationFn: (next: AutoTrackingPolicy) =>
      updateAutoTrackingPolicy(client, organizationSlug, next),
    onSuccess: async ({ policy }) => {
      queryClient.setQueryData<AutoTrackingState>(key, (old) =>
        old === undefined ? old : { ...old, policy },
      );
      await queryClient.invalidateQueries({ queryKey: key });
      setDraft(null);
      setSaved(true);
    },
  });

  const cancel = () => {
    setDraft(null);
    setSaved(false);
    save.reset();
  };

  return (
    <section className="tm-dlscan" aria-labelledby={titleId}>
      <h2 id={titleId} className="tm-dlscan__title">
        {tr('AutoTimePolicy.title', 'Automatic time tracking')}
      </h2>
      <p className="tm-dlscan__intro">
        {tr(
          'AutoTimePolicy.intro',
          'The automatic timer counts working time while a person uses their computer and pauses when they step away. Only active or idle state and times are recorded: no screenshots, keystrokes, app names or web addresses.',
        )}
      </p>

      {current.isError ? (
        <InlineAlert tone="danger" live>
          {tr('AutoTimePolicy.loadError', 'The setting could not be loaded.')}
        </InlineAlert>
      ) : current.isPending ? (
        <LoadingRegion label={tr('AutoTimePolicy.title', 'Automatic time tracking')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : (
        <>
          <div
            role="radiogroup"
            aria-labelledby={titleId}
            aria-readonly={isOwner ? undefined : true}
            className="tm-dlscan__choices"
            data-readonly={!isOwner}
          >
            {AUTO_TRACKING_POLICIES.map((choice) => {
              const checked = value === choice;
              const hintId = `${name}-${choice}-hint`;
              const [labelKey, labelEnglish] = CHOICES[choice].label;
              const [hintKey, hintEnglish] = CHOICES[choice].hint;
              return (
                <label key={choice} className="tm-dlscan-option" data-checked={checked}>
                  <input
                    type="radio"
                    className="tm-dlscan-radio"
                    name={name}
                    value={choice}
                    checked={checked}
                    disabled={!isOwner || save.isPending}
                    aria-describedby={hintId}
                    onChange={() => {
                      setSaved(false);
                      setDraft(choice);
                    }}
                  />
                  <span className="tm-dlscan-option__label">
                    {tr(labelKey, labelEnglish)}
                    {choice === 'optional' ? (
                      <Badge>{tr('AutoTimePolicy.default', 'Default')}</Badge>
                    ) : null}
                  </span>
                  <span className="tm-dlscan-option__hint" id={hintId}>
                    {tr(hintKey, hintEnglish)}
                  </span>
                </label>
              );
            })}
          </div>

          {isOwner ? (
            <>
              {save.isError ? (
                <InlineAlert tone="danger" live>
                  {tr('AutoTimePolicy.saveError', 'The setting was not saved. Try again.')}
                </InlineAlert>
              ) : null}
              {saved && draft === null ? (
                <InlineAlert tone="success" live>
                  {tr('AutoTimePolicy.saved', 'Saved.')}
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
                  {tr('AutoTimePolicy.cancel', 'Cancel')}
                </Button>
                <Button
                  type="button"
                  tone="ink"
                  loading={save.isPending}
                  loadingLabel={tr('AutoTimePolicy.saving', 'Saving')}
                  disabled={draft === null || draft === stored}
                  onClick={() => save.mutate(value)}
                >
                  {tr('AutoTimePolicy.save', 'Save')}
                </Button>
              </div>
            </>
          ) : (
            <InlineAlert tone="neutral">
              {tr('AutoTimePolicy.ownerOnly', 'Only the company owner can change this.')}
            </InlineAlert>
          )}
        </>
      )}
    </section>
  );
}
