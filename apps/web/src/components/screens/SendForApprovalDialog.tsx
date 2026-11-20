'use client';

import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Checkbox, DateField, InlineAlert, Select } from '@tmanage/ui';
import { listApprovers, sendForApproval } from '../../lib/api/deliverables';
import type { DeliverableVersionView, SendForApprovalView } from '../../lib/api/deliverables';
import type { ApiClient } from '../../lib/api/client';
import { describeDeliverableError, useDeliverablesT } from './DeliverablesScreen';

export interface SendForApprovalDialogProps {
  api: ApiClient;
  organizationSlug: string;
  deliverableId: string;
  deliverableTitle: string;
  version: DeliverableVersionView;
  onClose: () => void;
  onSent: (sent: SendForApprovalView) => void;
}

/**
 * **Send for approval (BG2, Figma t8-a, 371:1747 EN / 371:2173 AR).**
 *
 * The version pill, an approver picked from the people with approval authority, the date the
 * decision is needed by, what the client should check, and "Email the approver now". The info line
 * says the decision is tied to this version: uploading a new one asks again.
 */
export function SendForApprovalDialog({
  api,
  organizationSlug,
  deliverableId,
  deliverableTitle,
  version,
  onClose,
  onSent,
}: SendForApprovalDialogProps) {
  const t = useDeliverablesT();
  const titleId = useId();

  const approvers = useQuery({
    queryKey: ['deliverable-approvers', organizationSlug, deliverableId],
    queryFn: () => listApprovers(api, organizationSlug, deliverableId),
  });

  const [approverId, setApproverId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [checkNote, setCheckNote] = useState('');
  const [notify, setNotify] = useState(true);

  const chosen = approverId !== '' ? approverId : (approvers.data?.[0]?.userId ?? '');

  const send = useMutation({
    mutationFn: () =>
      sendForApproval(api, organizationSlug, deliverableId, version.id, {
        approverIds: [chosen],
        dueDate: dueDate === '' ? null : dueDate,
        checkNote: checkNote.trim() === '' ? null : checkNote.trim(),
        notify,
      }),
    onSuccess: onSent,
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const versionLabel = `v${version.versionNo ?? ''}`;
  const canSend = chosen !== '' && !send.isPending;

  return (
    <div className="tm-command-palette__backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="tm-card tm-stack"
        style={{
          inlineSize: 'min(560px, 100%)',
          borderRadius: 'var(--r-sheet)',
          padding: 'var(--s6)',
          background: 'var(--paper-0)',
        }}
      >
        <h2 id={titleId} className="tm-heading-2">
          {t('Deliverables.sendTitle')}
        </h2>

        <div className="tm-row">
          <span className="tm-badge tm-badge--mono">{versionLabel}</span>
          <div className="tm-stack tm-stack--tight">
            <p className="tm-heading-3">{deliverableTitle}</p>
            <p className="tm-field__hint">
              {t('Deliverables.uploadedOn')} {version.createdAt.slice(0, 10)}
            </p>
          </div>
        </div>

        <form
          noValidate
          className="tm-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSend) send.mutate();
          }}
        >
          <Select
            label={t('Deliverables.approverLabel')}
            hint={t('Deliverables.approverHint')}
            value={chosen}
            onChange={(event) => setApproverId(event.target.value)}
            disabled={approvers.isPending}
            required
          >
            {(approvers.data ?? []).map((approver) => (
              <option key={approver.userId} value={approver.userId}>
                {approver.displayName} · {approver.clientOrganizationName}
              </option>
            ))}
          </Select>
          {approvers.isSuccess && approvers.data.length === 0 ? (
            <InlineAlert tone="warning" title={t('Deliverables.noApprovers')}>
              {t('Deliverables.noApproversBody')}
            </InlineAlert>
          ) : null}

          <DateField
            label={t('Deliverables.dueLabel')}
            value={dueDate}
            onValueChange={setDueDate}
          />

          <div className="tm-field">
            <label className="tm-field__label" htmlFor={`${titleId}-check`}>
              {t('Deliverables.checkLabel')}
            </label>
            <textarea
              id={`${titleId}-check`}
              className="tm-field__control"
              value={checkNote}
              placeholder={t('Deliverables.checkPlaceholder')}
              onChange={(event) => setCheckNote(event.target.value)}
              maxLength={2000}
              rows={2}
            />
          </div>

          <Checkbox
            label={t('Deliverables.notifyLabel')}
            checked={notify}
            onChange={(event) => setNotify(event.target.checked)}
          />

          <InlineAlert tone="client">
            {t('Deliverables.tiedToVersion').replace('{version}', String(version.versionNo ?? ''))}
          </InlineAlert>

          {send.isError ? (
            <InlineAlert tone="danger" title={t('Deliverables.sendFailed')} live>
              {describeDeliverableError(send.error, t)}
            </InlineAlert>
          ) : null}

          <div className="tm-row tm-row--end">
            <Button type="button" tone="outline" size="accessible" onClick={onClose}>
              {t('Deliverables.cancel')}
            </Button>
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              disabled={!canSend}
              loading={send.isPending}
              loadingLabel={t('Deliverables.sending')}
            >
              {t('Deliverables.send')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
