'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  isDownloadsBeforeScan,
  readDownloadScanPolicy,
  updateDownloadScanPolicy,
  type DownloadsBeforeScan,
} from '../../lib/api/download-scan-policy';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import './download-scan-policy.css';

export interface DownloadScanPolicyCardProps {
  readonly organizationSlug: string;
  readonly client: ApiClient;
  /** Only the company owner may change the choice; everyone else who can open Control reads it. */
  readonly isOwner: boolean;
}

const CHOICES: readonly {
  readonly value: DownloadsBeforeScan;
  readonly label: MessageKey;
  readonly hint: MessageKey;
  readonly isDefault: boolean;
}[] = [
  {
    value: 'allow_labeled',
    label: 'DownloadScan.allowLabel',
    hint: 'DownloadScan.allowHint',
    isDefault: true,
  },
  {
    value: 'block',
    label: 'DownloadScan.blockLabel',
    hint: 'DownloadScan.blockHint',
    isDefault: false,
  },
];

/**
 * **B5 — "Downloads before a virus scan" (Figma section 388:3983).**
 *
 * The owner picks one of two choices (a radio group drawn as two option cards) and saves; Cancel
 * puts the stored choice back. A note warns when no virus scanner is connected. Anyone else who can
 * open Control sees the same choices dimmed and read-only, with the owner-only line. The change is
 * audited by the API.
 */
export function DownloadScanPolicyCard({
  organizationSlug,
  client,
  isOwner,
}: DownloadScanPolicyCardProps) {
  const t = useT();
  const queryClient = useQueryClient();
  const titleId = useId();
  const name = useId();
  const queryKey = ['download-scan-policy', organizationSlug];

  const policy = useQuery({
    queryKey,
    queryFn: () => readDownloadScanPolicy(client, organizationSlug),
  });
  const stored: DownloadsBeforeScan = isDownloadsBeforeScan(policy.data?.downloadsBeforeScan)
    ? policy.data.downloadsBeforeScan
    : 'allow_labeled';
  const [draft, setDraft] = useState<DownloadsBeforeScan | null>(null);
  const [saved, setSaved] = useState(false);
  const value = draft ?? stored;

  const save = useMutation({
    mutationFn: (next: DownloadsBeforeScan) =>
      updateDownloadScanPolicy(client, organizationSlug, next),
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
        {t('DownloadScan.title')}
      </h2>
      <p className="tm-dlscan__intro">{t('DownloadScan.intro')}</p>

      {policy.isError ? (
        <InlineAlert tone="danger" live>
          {t('DownloadScan.loadError')}
        </InlineAlert>
      ) : policy.isPending ? (
        <LoadingRegion label={t('DownloadScan.title')}>
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
            {CHOICES.map((choice) => {
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
              {policy.data?.scannerConfigured === false ? (
                <InlineAlert tone="warning">{t('DownloadScan.noScanner')}</InlineAlert>
              ) : null}
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
