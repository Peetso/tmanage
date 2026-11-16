'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, Select, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  listHandoverTargets,
  requestStorageHandover,
  type RootOwnerView,
  type StorageProvider,
} from '../../lib/api/storage-root';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/storage.css';

export interface StorageRootNoticeProps {
  organizationSlug: string;
  client: ApiClient;
  provider: StorageProvider;
  rootOwner: RootOwnerView;
  busy: boolean;
  /** Reconnect with the reader's own account (completes a hand-over named for them). */
  onTakeOver: () => void;
  /** The status changed on the server (a hand-over was named): read it again. */
  onChanged: () => void;
}

/**
 * 51-17. Inside a connected storage card (Control > Storage): who owns the root, the steer to a
 * company-owned place when it is one person's drive, and the hand-over. Only people who manage the
 * organization get a `rootOwner` with a hand-over state; the API decides every action again.
 */
export function StorageRootNotice({
  organizationSlug,
  client,
  provider,
  rootOwner,
  busy,
  onTakeOver,
  onChanged,
}: StorageRootNoticeProps) {
  const tr = useTOr();
  const [handingOver, setHandingOver] = useState(false);
  const google = provider === 'google_drive';

  return (
    <>
      {rootOwner.handover === 'pending_for_me' ? (
        <InlineAlert
          tone="warning"
          title={tr('StorageRoot.takeOverTitle', 'You were asked to take over company storage')}
        >
          {tr(
            'StorageRoot.takeOverBody',
            'Sign in with your own account. The files stay where they are.',
          )}
        </InlineAlert>
      ) : rootOwner.recommendCompanyRoot ? (
        <InlineAlert
          tone="warning"
          title={tr('StorageRoot.personalTitle', 'These files are in one person’s drive')}
        >
          {google
            ? tr(
                'StorageRoot.personalBodyGoogle',
                'If this account is removed, the files go with it. Choose a Shared Drive so the company keeps them.',
              )
            : tr(
                'StorageRoot.personalBodyMicrosoft',
                'If this account is removed, the files go with it. Choose a SharePoint library so the company keeps them.',
              )}
        </InlineAlert>
      ) : null}
      {rootOwner.handover === 'pending' ? (
        <InlineAlert tone="neutral" title={tr('StorageRoot.pendingTitle', 'Hand-over requested')}>
          {tr(
            'StorageRoot.pendingBody',
            'The admin you chose takes over when they sign in from this page.',
          )}
        </InlineAlert>
      ) : null}
      <div className="tm-storage__actions">
        {rootOwner.handover === 'pending_for_me' ? (
          <Button tone="lime" size="feature" loading={busy} onClick={onTakeOver}>
            {tr('StorageRoot.takeOver', 'Take over')}
          </Button>
        ) : (
          <Button
            tone="outline"
            size="feature"
            disabled={busy}
            title={tr(
              'StorageRoot.handOverHint',
              'Give this connection to another admin, for example before someone leaves.',
            )}
            onClick={() => setHandingOver(true)}
          >
            {tr('StorageRoot.handOver', 'Hand over')}
          </Button>
        )}
      </div>
      {handingOver ? (
        <HandoverDialog
          organizationSlug={organizationSlug}
          client={client}
          provider={provider}
          onClose={() => setHandingOver(false)}
          onDone={() => {
            setHandingOver(false);
            onChanged();
          }}
        />
      ) : null}
    </>
  );
}

interface HandoverDialogProps {
  organizationSlug: string;
  client: ApiClient;
  provider: StorageProvider;
  onClose: () => void;
  onDone: () => void;
}

function HandoverDialog({
  organizationSlug,
  client,
  provider,
  onClose,
  onDone,
}: HandoverDialogProps) {
  const tr = useTOr();
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const [toUserId, setToUserId] = useState('');
  const targets = useQuery({
    queryKey: ['storage-handover-targets', organizationSlug, provider],
    queryFn: () => listHandoverTargets(client, organizationSlug, provider),
  });
  const request = useMutation({
    mutationFn: () => requestStorageHandover(client, organizationSlug, { provider, toUserId }),
    onSuccess: onDone,
  });

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('select, button')?.focus();
  }, [targets.isPending]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const list = targets.data ?? [];

  return (
    <div className="tm-drive-files-scrim">
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="tm-drive-files"
      >
        <h2 id={titleId} className="tm-drive-files__title">
          {tr('StorageRoot.dialogTitle', 'Hand over company storage')}
        </h2>
        <p className="tm-drive-files__lede">
          {tr(
            'StorageRoot.dialogLede',
            'Choose an admin. They sign in with their own account, and the files stay where they are.',
          )}
        </p>
        <div className="tm-drive-files__body" aria-busy={targets.isPending ? 'true' : undefined}>
          {targets.isPending ? (
            <Skeleton height="40px" />
          ) : targets.isError || request.isError ? (
            <InlineAlert
              tone="danger"
              title={tr('StorageRoot.failedTitle', 'That did not work')}
              live
            >
              {tr('StorageRoot.failedBody', 'Nothing changed. Try again.')}
            </InlineAlert>
          ) : list.length === 0 ? (
            <p className="tm-drive-files__empty">
              {tr('StorageRoot.noAdmins', 'There is no other admin yet. Invite one first.')}
            </p>
          ) : null}
          {list.length > 0 ? (
            <Select
              label={tr('StorageRoot.adminLabel', 'New owner of the connection')}
              value={toUserId}
              disabled={request.isPending}
              onChange={(event) => setToUserId(event.target.value)}
            >
              <option value="">{tr('StorageRoot.adminPlaceholder', 'Choose an admin')}</option>
              {list.map((target) => (
                <option key={target.userId} value={target.userId}>
                  {target.displayName}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
        <div className="tm-drive-files__actions">
          <Button tone="outline" onClick={onClose}>
            {tr('DriveAttach.cancel', 'Cancel')}
          </Button>
          <Button
            tone="ink"
            loading={request.isPending}
            disabled={toUserId === ''}
            onClick={() => request.mutate()}
          >
            {tr('StorageRoot.confirm', 'Hand over')}
          </Button>
        </div>
      </section>
    </div>
  );
}
