'use client';

import { useEffect, useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { useClientsT } from './InviteClientDialog';
import { archiveClientOrganization, renameClientOrganization } from '../../lib/api/clients';
import type { ClientOrganization } from '../../lib/api/clients';
import type { ApiClient } from '../../lib/api/client';
import { describePeopleError } from '../screens/peopleShared';
import '../../styles/screens/clients.css';

/**
 * The client company page's two dialogs (moved out of `ClientCompanyScreen` with ONEPAGE, B04,
 * unchanged): rename (Figma 446:37470) and archive with a confirmation (446:37514).
 */

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
}

export interface CompanyDialogProps {
  api: ApiClient;
  organizationSlug: string;
  organization: ClientOrganization;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}

/** Figma "Clients · Rename client company (2026-10-31 live-test fix)" 446:37470. */
export function RenameCompanyDialog({
  api,
  organizationSlug,
  organization,
  onClose,
  onDone,
}: CompanyDialogProps) {
  const t = useClientsT();
  const titleId = useId();
  const [name, setName] = useState(organization.name);
  useEscape(onClose);

  const save = useMutation({
    mutationFn: () => renameClientOrganization(api, organizationSlug, organization, name.trim()),
    onSuccess: () => onDone(),
  });
  const canSave = name.trim() !== '' && name.trim() !== organization.name && !save.isPending;

  return (
    <div className="tm-command-palette__backdrop cl-backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="cl-dialog">
        <h2 id={titleId} className="cl-dialog__title">
          {t('Clients.renameTitle')}
        </h2>
        <p className="cl-dialog__lead">{t('Clients.renameLead')}</p>
        <form
          noValidate
          className="cl-dialog__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) save.mutate();
          }}
        >
          <Field
            label={t('Clients.companyNameLabel')}
            hint={t('Clients.renameHint')}
            autoComplete="off"
            value={name}
            maxLength={190}
            onChange={(event) => setName(event.target.value)}
            required
          />
          {save.isError ? (
            <InlineAlert tone="danger" title={t('Clients.renameFailed')} live>
              {describePeopleError(save.error)}
            </InlineAlert>
          ) : null}
          <div className="cl-dialog__actions">
            <Button type="button" tone="outline" size="accessible" onClick={onClose}>
              {t('Clients.cancel')}
            </Button>
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              disabled={!canSave}
              loading={save.isPending}
              loadingLabel={t('Clients.saving')}
            >
              {t('Clients.saveName')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Figma "Clients · Archive client company, confirm (2026-10-31 live-test fix)" 446:37514. */
export function ArchiveCompanyDialog({
  api,
  organizationSlug,
  organization,
  onClose,
  onDone,
}: CompanyDialogProps) {
  const t = useClientsT();
  const titleId = useId();
  useEscape(onClose);

  const archive = useMutation({
    mutationFn: () => archiveClientOrganization(api, organizationSlug, organization.id),
    onSuccess: () => onDone(),
  });

  return (
    <div className="tm-command-palette__backdrop cl-backdrop">
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="cl-dialog">
        <h2 id={titleId} className="cl-dialog__title">
          {t('Clients.archiveTitle', { name: organization.name })}
        </h2>
        <p className="cl-dialog__lead">{t('Clients.archiveBody')}</p>
        {archive.isError ? (
          <InlineAlert tone="danger" title={t('Clients.archiveFailed')} live>
            {describePeopleError(archive.error)}
          </InlineAlert>
        ) : null}
        <div className="cl-dialog__actions">
          <Button type="button" tone="outline" size="accessible" onClick={onClose}>
            {t('Clients.cancel')}
          </Button>
          <Button
            type="button"
            tone="destructive"
            size="accessible"
            loading={archive.isPending}
            loadingLabel={t('Clients.archiving')}
            onClick={() => archive.mutate()}
          >
            {t('Clients.archiveClient')}
          </Button>
        </div>
      </div>
    </div>
  );
}
