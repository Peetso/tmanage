'use client';

import { useId, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import './download-scan-policy.css';

/** One option card of an owner policy: its value, words and whether it is the default. */
export interface OwnerChoice<T extends string> {
  readonly value: T;
  readonly label: MessageKey;
  readonly hint: MessageKey;
  readonly isDefault: boolean;
}

export interface OwnerChoiceCardProps<V, T extends string> {
  readonly title: MessageKey;
  readonly intro: MessageKey;
  readonly choices: readonly OwnerChoice<T>[];
  readonly queryKey: readonly unknown[];
  readonly read: () => Promise<V>;
  readonly write: (next: T) => Promise<V>;
  /** The stored choice in a view read back from the API. */
  readonly valueOf: (view: V | undefined) => T;
  /** Notes under the choices for the owner (a missing scanner, what the choice means now). */
  readonly notes?: (view: V | undefined) => ReactNode;
  /** Only the company owner may change the choice; everyone else who can open Control reads it. */
  readonly isOwner: boolean;
}

/**
 * An owner-only workspace policy drawn as a radio group of option cards (Figma section 388:3983,
 * first built for "Downloads before a virus scan"). The owner picks and saves; Cancel puts the
 * stored choice back. Anyone else sees the same choices dimmed and read-only, with the owner-only
 * line. The API audits the change.
 */
export function OwnerChoiceCard<V, T extends string>({
  title,
  intro,
  choices,
  queryKey,
  read,
  write,
  valueOf,
  notes,
  isOwner,
}: OwnerChoiceCardProps<V, T>) {
  const t = useT();
  const queryClient = useQueryClient();
  const titleId = useId();
  const name = useId();

  const policy = useQuery({ queryKey, queryFn: read });
  const stored = valueOf(policy.data);
  const [draft, setDraft] = useState<T | null>(null);
  const [saved, setSaved] = useState(false);
  const value = draft ?? stored;

  const save = useMutation({
    mutationFn: write,
    onSuccess: (view) => {
      queryClient.setQueryData(queryKey, view);
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
        {t(title)}
      </h2>
      <p className="tm-dlscan__intro">{t(intro)}</p>

      {policy.isError ? (
        <InlineAlert tone="danger" live>
          {t('DownloadScan.loadError')}
        </InlineAlert>
      ) : policy.isPending ? (
        <LoadingRegion label={t(title)}>
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
            {choices.map((choice) => {
              const checked = value === choice.value;
              const hintId = `${name}-${choice.value}-hint`;
              return (
                <label key={choice.value} className="tm-dlscan-option" data-checked={checked}>
                  <input
                    type="radio"
                    className="tm-dlscan-radio"
                    name={name}
                    value={choice.value}
                    checked={checked}
                    disabled={!isOwner || save.isPending}
                    aria-describedby={hintId}
                    onChange={() => {
                      setSaved(false);
                      setDraft(choice.value);
                    }}
                  />
                  <span className="tm-dlscan-option__label">
                    {t(choice.label)}
                    {choice.isDefault ? <Badge>{t('DownloadScan.default')}</Badge> : null}
                  </span>
                  <span className="tm-dlscan-option__hint" id={hintId}>
                    {t(choice.hint)}
                  </span>
                </label>
              );
            })}
          </div>

          {isOwner ? (
            <>
              {notes?.(policy.data)}
              {save.isError ? (
                <InlineAlert tone="danger" live>
                  {t('DownloadScan.saveError')}
                </InlineAlert>
              ) : null}
              {saved && draft === null ? (
                <InlineAlert tone="success" live>
                  {t('DownloadScan.saved')}
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
                  {t('DownloadScan.cancel')}
                </Button>
                <Button
                  type="button"
                  tone="ink"
                  loading={save.isPending}
                  loadingLabel={t('DownloadScan.saving')}
                  disabled={draft === null || draft === stored}
                  onClick={() => save.mutate(value)}
                >
                  {t('DownloadScan.save')}
                </Button>
              </div>
            </>
          ) : (
            <InlineAlert tone="neutral">{t('DownloadScan.ownerOnly')}</InlineAlert>
          )}
        </>
      )}
    </section>
  );
}
