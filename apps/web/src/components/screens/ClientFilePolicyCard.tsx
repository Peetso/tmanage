'use client';

import { InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  isClientFilesPolicy,
  readClientFilePolicy,
  updateClientFilePolicy,
  type ClientFilePolicyView,
  type ClientFilesPolicy,
} from '../../lib/api/client-file-policy';
import { useT } from '../../lib/i18n/use-t';
import { OwnerChoiceCard, type OwnerChoice } from './OwnerChoiceCard';

export interface ClientFilePolicyCardProps {
  readonly organizationSlug: string;
  readonly client: ApiClient;
  readonly isOwner: boolean;
}

const CHOICES: readonly OwnerChoice<ClientFilesPolicy>[] = [
  {
    value: 'checked',
    label: 'ClientFilePolicy.checkedLabel',
    hint: 'ClientFilePolicy.checkedHint',
    isDefault: true,
  },
  {
    value: 'virus_scanned',
    label: 'ClientFilePolicy.scannedLabel',
    hint: 'ClientFilePolicy.scannedHint',
    isDefault: false,
  },
];

/**
 * FIX6 item 1 — "Files clients can receive", the owner's choice beside "Downloads before a virus
 * scan". Says plainly when the choice means nothing can be sent to clients (virus-scanned only,
 * and no scanner is set up).
 */
export function ClientFilePolicyCard({
  organizationSlug,
  client,
  isOwner,
}: ClientFilePolicyCardProps) {
  const t = useT();
  return (
    <OwnerChoiceCard<ClientFilePolicyView, ClientFilesPolicy>
      title="ClientFilePolicy.title"
      intro="ClientFilePolicy.intro"
      choices={CHOICES}
      queryKey={['client-file-policy', organizationSlug]}
      read={() => readClientFilePolicy(client, organizationSlug)}
      write={(next) => updateClientFilePolicy(client, organizationSlug, next)}
      valueOf={(view) => (isClientFilesPolicy(view?.clientFiles) ? view.clientFiles : 'checked')}
      notes={(view) =>
        view?.sharingPossible === false ? (
          <InlineAlert tone="warning">{t('ClientFilePolicy.nothingCanBeShared')}</InlineAlert>
        ) : null
      }
      isOwner={isOwner}
    />
  );
}
