'use client';

import { InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  isDownloadsBeforeScan,
  readDownloadScanPolicy,
  updateDownloadScanPolicy,
  type DownloadScanPolicyView,
  type DownloadsBeforeScan,
} from '../../lib/api/download-scan-policy';
import { useT } from '../../lib/i18n/use-t';
import { OwnerChoiceCard, type OwnerChoice } from './OwnerChoiceCard';

export interface DownloadScanPolicyCardProps {
  readonly organizationSlug: string;
  readonly client: ApiClient;
  /** Only the company owner may change the choice; everyone else who can open Control reads it. */
  readonly isOwner: boolean;
}

const CHOICES: readonly OwnerChoice<DownloadsBeforeScan>[] = [
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
 * **B5 — "Downloads before a virus scan" (Figma section 388:3983).** The owner's choice of what a
 * download does before a virus scan, with a note when no virus scanner is connected.
 */
export function DownloadScanPolicyCard({
  organizationSlug,
  client,
  isOwner,
}: DownloadScanPolicyCardProps) {
  const t = useT();
  return (
    <OwnerChoiceCard<DownloadScanPolicyView, DownloadsBeforeScan>
      title="DownloadScan.title"
      intro="DownloadScan.intro"
      choices={CHOICES}
      queryKey={['download-scan-policy', organizationSlug]}
      read={() => readDownloadScanPolicy(client, organizationSlug)}
      write={(next) => updateDownloadScanPolicy(client, organizationSlug, next)}
      valueOf={(view) =>
        isDownloadsBeforeScan(view?.downloadsBeforeScan)
          ? view.downloadsBeforeScan
          : 'allow_labeled'
      }
      notes={(view) =>
        view?.scannerConfigured === false ? (
          <InlineAlert tone="warning">{t('DownloadScan.noScanner')}</InlineAlert>
        ) : null
      }
      isOwner={isOwner}
    />
  );
}
