'use client';

import { useId, useState } from 'react';
import { Button, Checkbox } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import {
  DueDatePicker,
  formatChipDay,
  isArabic,
  useA6T,
  WorkDialogFrame,
} from '../work/DueDatePicker';
import {
  firstNameOf,
  initialsOf,
  OwnerPickerDialog,
  useOwnerCandidates,
} from '../work/OwnerPickerDialog';
import '../screens/request-triage.css';

const RLM = '‏';

/** What the dialog hands back: the acceptance's owner, due day and whether to tell the client. */
export interface AcceptRequestChoice {
  readonly ownerUserId: string | null;
  /** `YYYY-MM-DD`, or `''` for an acceptance with no date yet. */
  readonly dueDay: string;
  readonly notifyClient: boolean;
}

export interface AcceptRequestDialogProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly requestTitle: string;
  /** "Youssef Adel" — the person who sent it. */
  readonly senderName: string;
  readonly clientName: string;
  /** The day the client asked for, the dialog's starting due date. */
  readonly initialDueDay: string;
  readonly saving?: boolean;
  readonly onAccept: (choice: AcceptRequestChoice) => void;
  readonly onClose: () => void;
}

/**
 * **Accept this request? (A7, Figma fq9-confirm-accept).**
 *
 * The request, its project and who sent it as summary rows; an Owner chip (A6's owner picker,
 * project members only) and a Due chip (A6's date picker) — the due day is the date the studio
 * commits to; "Tell <first name> it is accepted", ticked by default; Cancel / Accept request.
 */
export function AcceptRequestDialog({
  api,
  organizationSlug,
  projectId,
  projectName,
  requestTitle,
  senderName,
  clientName,
  initialDueDay,
  saving = false,
  onAccept,
  onClose,
}: AcceptRequestDialogProps) {
  const t = useA6T();
  const locale = useActiveLocale();
  const titleId = useId();
  const rtl = isArabic(locale) ? RLM : '';
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);
  const [dueDay, setDueDay] = useState(initialDueDay);
  const [notifyClient, setNotifyClient] = useState(true);
  const [popover, setPopover] = useState<'owner' | 'due' | null>(null);

  const owners = useOwnerCandidates(api, organizationSlug, projectId);
  const ownerName = owners.candidates.find((c) => c.userId === ownerUserId)?.displayName;
  const firstName = firstNameOf(senderName);

  return (
    <WorkDialogFrame labelledBy={titleId} onClose={onClose}>
      <div className="tm-rq-accept">
        <h2 id={titleId} className="tm-wk-dialog__title">
          {t('AcceptRequest.title')}
        </h2>
        <p className="tm-wk-dialog__lede">{t('AcceptRequest.lede')}</p>

        <dl className="tm-rq-summary">
          <div>
            <dt>{t('AcceptRequest.request')}</dt>
            <dd>{requestTitle}</dd>
          </div>
          <div>
            <dt>{t('AcceptRequest.project')}</dt>
            <dd>{projectName}</dd>
          </div>
          <div>
            <dt>{t('AcceptRequest.from')}</dt>
            <dd>
              {rtl}
              {senderName} · {clientName}
            </dd>
          </div>
        </dl>

        <div className="tm-wk-fact-chips">
          <button
            type="button"
            className="tm-wk-fact"
            aria-haspopup="dialog"
            onClick={() => setPopover('owner')}
          >
            {ownerUserId !== null ? (
              <span className="tm-wk-orb" aria-hidden="true">
                {initialsOf(ownerName ?? '')}
              </span>
            ) : null}
            <span className="tm-wk-fact__text">
              <span className="tm-wk-fact__label">{t('AcceptRequest.owner')}</span>
              <span className="tm-wk-fact__value">
                {ownerUserId === null ? t('AcceptRequest.nobody') : (ownerName ?? '…')}
              </span>
            </span>
            <span className="tm-wk-fact__caret" aria-hidden="true">
              ▾
            </span>
          </button>

          <div className="tm-wk-popover-anchor">
            <button
              type="button"
              className="tm-wk-fact"
              aria-haspopup="dialog"
              aria-expanded={popover === 'due'}
              onClick={() => setPopover(popover === 'due' ? null : 'due')}
            >
              <span className="tm-wk-fact__text">
                <span className="tm-wk-fact__label">{t('AcceptRequest.due')}</span>
                <span className="tm-wk-fact__value">
                  {dueDay === '' ? t('AcceptRequest.noDate') : formatChipDay(dueDay, locale)}
                </span>
              </span>
              <span className="tm-wk-fact__caret" aria-hidden="true">
                ▾
              </span>
            </button>
            {popover === 'due' ? (
              <DueDatePicker
                heading={t('AcceptRequest.due')}
                value={dueDay}
                onSet={(day) => {
                  setDueDay(day ?? '');
                  setPopover(null);
                }}
                onClose={() => setPopover(null)}
              />
            ) : null}
          </div>
        </div>

        <Checkbox
          label={t('AcceptRequest.tell', { name: firstName })}
          hint={t('AcceptRequest.tellHint')}
          checked={notifyClient}
          onChange={(event) => setNotifyClient(event.target.checked)}
        />

        <div className="tm-wk-dialog__actions">
          <Button tone="outline" size="accessible" onClick={onClose}>
            {t('AcceptRequest.cancel')}
          </Button>
          <Button
            tone="ink"
            size="accessible"
            loading={saving}
            loadingLabel={t('AcceptRequest.accepting')}
            onClick={() => onAccept({ ownerUserId, dueDay, notifyClient })}
          >
            {t('AcceptRequest.accept')}
          </Button>
        </div>
      </div>

      {popover === 'owner' ? (
        <OwnerPickerDialog
          projectName={projectName}
          candidates={owners.candidates}
          loading={owners.loading}
          value={ownerUserId}
          onAssign={(userId) => {
            setOwnerUserId(userId);
            setPopover(null);
          }}
          onClose={() => setPopover(null)}
        />
      ) : null}
    </WorkDialogFrame>
  );
}
