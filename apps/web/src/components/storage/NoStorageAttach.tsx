'use client';

import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { newCorrelationId } from '../../lib/api/client';
import { getStorageStatus } from '../../lib/api/google-drive';
import { openDirectConversation, postDirectMessage } from '../../lib/api/direct-conversations';
import { listPeople } from '../../lib/api/people';
import { roleMayUse } from '../../lib/role-capability';
import { attachStorageState } from '../../lib/storage-attach-state';
import type { AttachStorageState } from '../../lib/storage-attach-state';
import { useOrganizationRole } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/storage.css';

/**
 * The attach area's state for this person: whether Google Drive or OneDrive is the company's
 * storage (the status read every member may make), and, when neither is, whether this person may
 * choose one (`org.manage`). See {@link attachStorageState}.
 */
export function useAttachStorageState(
  organizationSlug: string,
  api: ApiClient,
): AttachStorageState {
  const { role, capabilities } = useOrganizationRole(organizationSlug);
  const storage = useQuery({
    queryKey: ['storage-status', organizationSlug],
    queryFn: () => getStorageStatus(api, organizationSlug),
    staleTime: 60_000,
  });
  return attachStorageState(storage.data, roleMayUse(role, capabilities, 'org.manage'));
}

export interface NoStorageAttachProps {
  readonly organizationSlug: string;
  readonly client: ApiClient;
  /** `connect` for an owner or admin, `ask` for everyone else. */
  readonly state: 'connect' | 'ask';
}

/**
 * Attach · no storage yet (Figma 419:23834 owner, 419:23867 member): in place of the attach
 * controls while the company has not chosen Google Drive or OneDrive. An owner or admin goes to
 * Control › Storage; anyone else asks the owner with a direct message.
 */
export function NoStorageAttach({ organizationSlug, client, state }: NoStorageAttachProps) {
  const t = useT();
  return (
    <section className="tm-no-storage" aria-label={t('NoStorageAttach.eyebrow')}>
      <p className="tm-no-storage__eyebrow">{t('NoStorageAttach.eyebrow')}</p>
      <p className="tm-no-storage__title">{t('NoStorageAttach.title')}</p>
      {state === 'connect' ? (
        <>
          <p className="tm-no-storage__body">{t('NoStorageAttach.ownerBody')}</p>
          <div className="tm-no-storage__action">
            <Link
              href={`/${organizationSlug}/admin/storage`}
              className="tm-button tm-button--lime tm-button--feature"
            >
              {t('NoStorageAttach.connect')}
            </Link>
            <p className="tm-no-storage__hint">{t('NoStorageAttach.connectHint')}</p>
          </div>
        </>
      ) : (
        <AskAdmin organizationSlug={organizationSlug} client={client} />
      )}
    </section>
  );
}

function AskAdmin({
  organizationSlug,
  client,
}: {
  readonly organizationSlug: string;
  readonly client: ApiClient;
}) {
  const t = useT();
  const owner = useQuery({
    queryKey: ['storage-owner', organizationSlug],
    queryFn: async () => {
      const { people } = await listPeople(client, organizationSlug, { limit: 200 });
      return (
        people.find((person) => person.role === 'owner' && person.status === 'active') ??
        people.find((person) => person.role === 'owner') ??
        null
      );
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  const ownerName = owner.data?.displayName ?? null;
  const ask = useMutation({
    mutationFn: async () => {
      const userId = owner.data?.userId;
      if (!userId) throw new Error('no_owner');
      const conversation = await openDirectConversation(client, organizationSlug, userId);
      await postDirectMessage(client, organizationSlug, conversation.id, {
        body: t('NoStorageAttach.message'),
        clientGeneratedId: newCorrelationId(),
      });
    },
  });

  const hint = ask.isSuccess
    ? t('NoStorageAttach.asked').replace('{name}', ownerName ?? '')
    : ask.isError
      ? t('NoStorageAttach.askFailed')
      : ownerName
        ? t('NoStorageAttach.askHint').replace('{name}', ownerName)
        : t('NoStorageAttach.askHintNoName');

  return (
    <>
      <p className="tm-no-storage__body">{t('NoStorageAttach.memberBody')}</p>
      <div className="tm-no-storage__action">
        <Button
          tone="outline"
          size="feature"
          loading={ask.isPending}
          disabled={ask.isSuccess || owner.isPending}
          onClick={() => ask.mutate()}
        >
          {t('NoStorageAttach.ask')}
        </Button>
        <p className="tm-no-storage__hint" role="status">
          {hint}
        </p>
      </div>
    </>
  );
}
