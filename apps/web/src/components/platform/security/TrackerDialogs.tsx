'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InfoButton, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import {
  addAllowlistEntry,
  blockSource,
  markKnownTester,
  removeAllowlistEntry,
  removeSourceLabel,
  setNetworkPolicy,
  unblockSource,
} from '../../../lib/api/platform-security';
import type {
  AllowlistEntry,
  TrackAccount,
  TrackDetail,
  TrackSummary,
} from '../../../lib/api/platform-security';
import { signOutPlatformPersonEverywhere } from '../../../lib/api/platform-people';
import { useT } from '../../../lib/i18n/use-t';
import { withIsolates } from '../../../lib/i18n/with-isolates';
import { PLATFORM_ME_QUERY_KEY } from '../shared/usePlatformPermissions';
import { platformErrorText } from '../shared/ReasonDialog';
import { TrackerIcon } from './tracker-icons';
import { useAccountsPhrase } from './use-tracker-text';

/** The reason bounds the people routes hold (`requireReason`: 5 to 500 characters). */
const REASON_MIN = 5;
const REASON_MAX = 500;
const NOTE_MAX = 190;

export const TRACKS_KEY = ['platform', 'attack-tracks'] as const;
export const TRACK_KEY = ['platform', 'attack-track'] as const;
export const DOOR_KEY = ['platform', 'network-access'] as const;

export type TrackerDialogState =
  | {
      readonly kind: 'block';
      readonly track: TrackSummary;
      /** The allowlist entry the address is inside, when it is allowlisted. */
      readonly overlap?: string | null;
    }
  | { readonly kind: 'unblock'; readonly track: TrackSummary; readonly note: string | null }
  | { readonly kind: 'allow-source'; readonly track: TrackSummary }
  | { readonly kind: 'allow-refused'; readonly track: TrackSummary }
  | { readonly kind: 'allow-add' }
  | { readonly kind: 'allow-remove'; readonly entry: AllowlistEntry }
  | { readonly kind: 'door-off' }
  | { readonly kind: 'mark'; readonly track: TrackSummary }
  | { readonly kind: 'unmark'; readonly track: TrackSummary }
  | { readonly kind: 'accounts'; readonly detail: TrackDetail }
  | {
      readonly kind: 'sign-out';
      readonly account: TrackAccount;
      readonly detail: TrackDetail;
    };

/** What the live region says once a dialog's action is done. */
export type TrackerDone = string;

// ── The frame ──────────────────────────────────────────────────────────────

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The tracker's dialog (Figma 841:906 states): title and close, the content, Cancel at the start
 * and the confirm button at the far end. A modal: focus starts on the first field (or Cancel),
 * Tab stays inside, Escape closes (WAI-ARIA APG, Dialog (Modal) pattern).
 */
export function TrackerDialog({
  title,
  wide = false,
  onClose,
  children,
}: {
  readonly title: ReactNode;
  readonly wide?: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const t = useT();
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = panel.current;
    const first =
      node?.querySelector<HTMLElement>('input, textarea') ??
      node?.querySelector<HTMLElement>('[data-autofocus]') ??
      node?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, []);

  function onKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || panel.current === null) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="tm-at-scrim">
      {/* The modal's own Escape and Tab handling (WAI-ARIA APG, Dialog (Modal) pattern). */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={wide ? 'tm-at-dialog tm-at-dialog--wide' : 'tm-at-dialog'}
        onKeyDown={onKey}
      >
        <div className="tm-at-dialog__head">
          <h2 id={titleId} className="tm-at-dialog__title">
            {title}
          </h2>
          <button
            type="button"
            className="tm-at-icon-button tm-at-icon-button--small"
            aria-label={t('AttackTracker.close')}
            onClick={onClose}
          >
            <TrackerIcon name="close" />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

/** The address a dialog acts on, one left-to-right run, with an optional ⓘ. */
function DialogValue({ value, info }: { readonly value: string; readonly info?: ReactNode }) {
  return (
    <p className="tm-at-dialog__value">
      <bdi dir="ltr">{value}</bdi>
      {info}
    </p>
  );
}

function BlockInfo() {
  const t = useT();
  return (
    <InfoButton title={t('AttackTracker.blockSource')} label={t('AttackTracker.aboutBlock')}>
      {t('AttackTracker.infoBlock')}
    </InfoButton>
  );
}

/**
 * A confirm form: the fields, the API's refusal, and Cancel / confirm. A lapsed step-up re-opens
 * the step-up form through the `me` query, as every platform action does.
 */
function ConfirmForm({
  confirmLabel,
  destructive = false,
  disabled = false,
  refusal,
  onConfirm,
  onClose,
  children,
}: {
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  /** A refusal known before any request (the source is blocked). */
  readonly refusal?: string;
  /** Runs the action; returning `false` means "not valid yet", and nothing is sent. */
  readonly onConfirm: () => Promise<unknown> | false;
  readonly onClose: (done: boolean) => void;
  readonly children?: ReactNode;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [conflict, setConflict] = useState(false);
  const action = useMutation({
    mutationFn: async () => {
      const run = onConfirm();
      if (run === false) return 'invalid' as const;
      await run;
      return 'done' as const;
    },
    onSuccess: async (result) => {
      if (result !== 'done') return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: TRACKS_KEY }),
        queryClient.invalidateQueries({ queryKey: TRACK_KEY }),
        queryClient.invalidateQueries({ queryKey: DOOR_KEY }),
      ]);
      onClose(true);
    },
    onError: async (error) => {
      if (error instanceof ApiRequestError && error.status === 409) setConflict(true);
      if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
        await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
      }
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    action.mutate();
  }

  return (
    <form className="tm-at-column" onSubmit={submit} noValidate>
      {refusal ? (
        <InlineAlert tone="danger" live>
          {refusal}
        </InlineAlert>
      ) : null}
      {action.isError ? (
        <InlineAlert tone="danger" live>
          {platformErrorText(action.error, t)}
        </InlineAlert>
      ) : null}
      {children}
      <div className="tm-at-dialog__actions">
        <Button type="button" tone="outline" onClick={() => onClose(false)}>
          {t('AttackTracker.cancel')}
        </Button>
        <Button
          type="submit"
          tone={destructive ? 'destructive' : 'ink'}
          loading={action.isPending}
          loadingLabel={t('PlatformShared.working')}
          disabled={disabled || conflict || refusal !== undefined}
        >
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}

function NoteField({
  label,
  placeholder,
  value,
  onChange,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field
      label={label}
      placeholder={placeholder}
      value={value}
      maxLength={NOTE_MAX}
      autoComplete="off"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

// ── The dialogs ────────────────────────────────────────────────────────────

export interface TrackerDialogsProps {
  readonly api: ApiClient;
  readonly dialog: TrackerDialogState;
  /** Opens another dialog in place of this one (accounts → sign out). */
  readonly onOpen: (next: TrackerDialogState) => void;
  /** `done` carries the live-region sentence; null when cancelled. */
  readonly onClose: (done: TrackerDone | null) => void;
}

export function TrackerDialogs({ api, dialog, onOpen, onClose }: TrackerDialogsProps) {
  const t = useT();
  const [note, setNote] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const cancel = () => onClose(null);
  const closeWith = (message: TrackerDone) => (done: boolean) => onClose(done ? message : null);

  switch (dialog.kind) {
    case 'block':
      return (
        <TrackerDialog title={t('AttackTracker.blockTitle')} onClose={cancel}>
          <DialogValue value={dialog.track.ip} info={<BlockInfo />} />
          <ConfirmForm
            confirmLabel={t('AttackTracker.blockSource')}
            destructive
            {...(dialog.track.allowlisted
              ? {
                  refusal:
                    dialog.overlap == null
                      ? t('AttackTracker.blockOverlapsAllowlist')
                      : t('AttackTracker.blockOverlapsEntry').replace('{entry}', dialog.overlap),
                }
              : {})}
            onConfirm={() => blockSource(api, dialog.track.ip, note)}
            onClose={closeWith(t('AttackTracker.doneBlocked'))}
          >
            <NoteField
              label={t('AttackTracker.noteOptional')}
              placeholder={t('AttackTracker.blockNotePlaceholder')}
              value={note}
              onChange={setNote}
            />
          </ConfirmForm>
        </TrackerDialog>
      );
    case 'unblock':
      return (
        <TrackerDialog title={t('AttackTracker.unblockTitle')} onClose={cancel}>
          <DialogValue value={dialog.track.ip} info={<BlockInfo />} />
          {dialog.note ? <p className="tm-at-secondary">{dialog.note}</p> : null}
          <ConfirmForm
            confirmLabel={t('AttackTracker.unblock')}
            disabled={dialog.track.blockId === null}
            onConfirm={() =>
              dialog.track.blockId === null ? false : unblockSource(api, dialog.track.blockId)
            }
            onClose={closeWith(t('AttackTracker.doneUnblocked'))}
          />
        </TrackerDialog>
      );
    case 'allow-source':
    case 'allow-refused':
      return (
        <TrackerDialog title={t('AttackTracker.allowFromSourceTitle')} onClose={cancel}>
          <DialogValue
            value={dialog.track.ip}
            info={
              <InfoButton
                title={t('AttackTracker.allowlist')}
                label={t('AttackTracker.aboutAllowlist')}
              >
                {t('AttackTracker.infoAllowlist')}
              </InfoButton>
            }
          />
          <ConfirmForm
            confirmLabel={t('AttackTracker.addToAllowlist')}
            {...(dialog.kind === 'allow-refused'
              ? { refusal: t('AttackTracker.blockedRefusal') }
              : {})}
            onConfirm={() => addAllowlistEntry(api, dialog.track.ip, note)}
            onClose={closeWith(t('AttackTracker.doneAllowlisted'))}
          >
            <NoteField
              label={t('AttackTracker.note')}
              placeholder={t('AttackTracker.notePlaceholder')}
              value={note}
              onChange={setNote}
            />
          </ConfirmForm>
        </TrackerDialog>
      );
    case 'allow-add': {
      const missing = value.trim() === '';
      return (
        <TrackerDialog title={t('AttackTracker.allowAddTitle')} onClose={cancel}>
          <ConfirmForm
            confirmLabel={t('AttackTracker.add')}
            onConfirm={() => {
              setTried(true);
              return missing ? false : addAllowlistEntry(api, value.trim(), note);
            }}
            onClose={closeWith(t('AttackTracker.doneAllowlisted'))}
          >
            <Field
              label={t('AttackTracker.addressOrRange')}
              placeholder={t('AttackTracker.addressPlaceholder')}
              value={value}
              dir="ltr"
              maxLength={64}
              autoComplete="off"
              required
              onChange={(event) => setValue(event.target.value)}
              {...(tried && missing ? { error: t('AttackTracker.addressRequired') } : {})}
            />
            <NoteField
              label={t('AttackTracker.note')}
              placeholder={t('AttackTracker.notePlaceholder')}
              value={note}
              onChange={setNote}
            />
          </ConfirmForm>
        </TrackerDialog>
      );
    }
    case 'allow-remove':
      return (
        <TrackerDialog title={t('AttackTracker.removeTitle')} onClose={cancel}>
          <div>
            <DialogValue value={allowlistValue(dialog.entry)} />
            {dialog.entry.note ? <p className="tm-at-secondary">{dialog.entry.note}</p> : null}
          </div>
          <ConfirmForm
            confirmLabel={t('AttackTracker.remove')}
            destructive
            onConfirm={() => removeAllowlistEntry(api, dialog.entry.id)}
            onClose={closeWith(t('AttackTracker.doneRemoved'))}
          />
        </TrackerDialog>
      );
    case 'door-off':
      return (
        <TrackerDialog title={t('AttackTracker.doorOffTitle')} onClose={cancel}>
          <p className="tm-at-status">
            <span>{t('AttackTracker.policyLabel')}</span>
            <InfoButton title={t('AttackTracker.signInDoor')} label={t('AttackTracker.aboutDoor')}>
              {t('AttackTracker.infoDoor')}
            </InfoButton>
          </p>
          <ConfirmForm
            confirmLabel={t('AttackTracker.turnOff')}
            destructive
            onConfirm={() => setNetworkPolicy(api, 'allow')}
            onClose={closeWith(t('AttackTracker.doneDoorOff'))}
          />
        </TrackerDialog>
      );
    case 'mark':
      return (
        <TrackerDialog title={t('AttackTracker.markTitle')} onClose={cancel}>
          <DialogValue value={dialog.track.ip} />
          <ConfirmForm
            confirmLabel={t('AttackTracker.markTester')}
            onConfirm={() => markKnownTester(api, dialog.track.ip, note)}
            onClose={closeWith(t('AttackTracker.doneMarked'))}
          >
            <NoteField
              label={t('AttackTracker.note')}
              placeholder={t('AttackTracker.notePlaceholder')}
              value={note}
              onChange={setNote}
            />
          </ConfirmForm>
        </TrackerDialog>
      );
    case 'unmark':
      return (
        <TrackerDialog title={t('AttackTracker.unmarkTitle')} onClose={cancel}>
          <div>
            <DialogValue value={dialog.track.ip} />
            {dialog.track.labelNote ? (
              <p className="tm-at-secondary">{dialog.track.labelNote}</p>
            ) : null}
          </div>
          <ConfirmForm
            confirmLabel={t('AttackTracker.removeTesterMark')}
            disabled={dialog.track.labelId === null}
            onConfirm={() =>
              dialog.track.labelId === null ? false : removeSourceLabel(api, dialog.track.labelId)
            }
            onClose={closeWith(t('AttackTracker.doneUnmarked'))}
          />
        </TrackerDialog>
      );
    case 'accounts':
      return <AccountsDialog detail={dialog.detail} onOpen={onOpen} onClose={cancel} />;
    case 'sign-out': {
      const { account } = dialog;
      const short = reason.trim().length < REASON_MIN;
      return (
        <TrackerDialog
          title={withIsolates(t('AttackTracker.signOutTitle'), { name: account.displayName })}
          onClose={cancel}
        >
          <p className="tm-at-secondary">
            <bdi dir="ltr">{account.email}</bdi>
            {account.organizations[0] ? (
              <>
                {' · '}
                <bdi>{account.organizations[0].name}</bdi>
              </>
            ) : null}
          </p>
          <ConfirmForm
            confirmLabel={t('AttackTracker.signOutConfirm')}
            destructive
            onConfirm={() => {
              setTried(true);
              return short
                ? false
                : signOutPlatformPersonEverywhere(api, account.userId, reason.trim());
            }}
            onClose={closeWith(t('AttackTracker.doneSignedOut'))}
          >
            <Field
              label={t('AttackTracker.reason')}
              placeholder={t('AttackTracker.reasonPlaceholder')}
              value={reason}
              minLength={REASON_MIN}
              maxLength={REASON_MAX}
              autoComplete="off"
              required
              onChange={(event) => setReason(event.target.value)}
              {...(tried && short ? { error: t('AttackTracker.reasonError') } : {})}
            />
          </ConfirmForm>
        </TrackerDialog>
      );
    }
  }
}

/** An allowlist value as people write it: an ASN entry reads `AS13335`. */
export function allowlistValue(entry: AllowlistEntry): string {
  return entry.kind === 'asn' ? `AS${entry.value}` : entry.value;
}

/** The accounts a source tried (must-fix 15): name, e-mail, organisation; who got in first. */
function AccountsDialog({
  detail,
  onOpen,
  onClose,
}: {
  readonly detail: TrackDetail;
  readonly onOpen: (next: TrackerDialogState) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const accountsTitle = useAccountsPhrase('AttackTracker.accountsTargetedTitle');
  const gotIn = new Set(
    detail.timeline
      .filter((step) => step.outcome === 'succeeded' && step.userId !== null)
      .map((step) => step.userId),
  );
  const accounts = [...detail.accounts].sort(
    (a, b) => Number(gotIn.has(b.userId)) - Number(gotIn.has(a.userId)),
  );
  return (
    <TrackerDialog wide title={accountsTitle(detail.accountsTotal)} onClose={onClose}>
      <p className="tm-at-mono">
        <bdi dir="ltr">{detail.ip}</bdi>
      </p>
      {detail.accountsVisible ? (
        <ul className="tm-at-accounts">
          {accounts.map((account) => (
            <li key={account.userId}>
              <span className="tm-at-accounts__name">
                <bdi>{account.displayName}</bdi>
                <bdi dir="ltr" className="tm-at-accounts__org">
                  {account.email}
                </bdi>
              </span>
              <span className="tm-at-accounts__org">
                {account.organizations.map((org) => org.name).join(', ')}
              </span>
              <span>
                {gotIn.has(account.userId) ? (
                  <StateCapsule state="blocked">{t('AttackTracker.gotIn')}</StateCapsule>
                ) : null}
              </span>
              {gotIn.has(account.userId) && detail.canSignOutAccounts ? (
                <span className="tm-at-accounts__action">
                  <Button
                    type="button"
                    tone="outline"
                    size="compact"
                    onClick={() => onOpen({ kind: 'sign-out', account, detail })}
                  >
                    {t('AttackTracker.signOutEverywhere')}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <InlineAlert tone="neutral">{t('AttackTracker.accountsHidden')}</InlineAlert>
      )}
      <p className="tm-at-secondary">
        {withIsolates(t('AttackTracker.showingAccounts'), {
          shown: String(detail.accounts.length),
          total: String(detail.accountsTotal),
        })}
      </p>
    </TrackerDialog>
  );
}
