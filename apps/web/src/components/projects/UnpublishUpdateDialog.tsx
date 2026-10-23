'use client';

import { useCallback, useEffect, useId, useRef } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import './update-card.css';

/**
 * A10's message lookup with `{name}` placeholders. Typed-cast until the wave's i18n fragment
 * (`i18n-A10.*.json`) is merged into the catalogs.
 */
export function useA10T(): (key: string, vars?: Readonly<Record<string, string>>) => string {
  const t = useT();
  return useCallback(
    (key: string, vars?: Readonly<Record<string, string>>) => {
      let text = t(key as MessageKey);
      if (vars) {
        for (const [name, value] of Object.entries(vars))
          text = text.split(`{${name}}`).join(value);
      }
      return text;
    },
    [t],
  );
}

/**
 * "Tue 21 Oct" / "الثلاثاء 21 أكتوبر" — weekday, day and month with no commas, Latin digits in
 * Arabic the way the Figma catalog writes them. `utc` reads a bare `YYYY-MM-DD` as that day.
 */
export function formatUpdateDay(value: string, locale: string, utc = false): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const arabic = locale.toLowerCase().startsWith('ar');
  const parts = new Intl.DateTimeFormat(arabic ? 'ar-u-nu-latn' : 'en-GB', {
    weekday: arabic ? 'long' : 'short',
    day: 'numeric',
    month: arabic ? 'long' : 'short',
    ...(utc ? { timeZone: 'UTC' } : {}),
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('weekday')} ${pick('day')} ${pick('month')}`;
}

export interface UnpublishUpdateDialogProps {
  readonly title: string;
  /** From the portal access log: who opened the update and when, or null when nobody has yet. */
  readonly clientOpened: { readonly clientName: string; readonly openedAt: string } | null;
  readonly locale: string;
  readonly unpublishing?: boolean;
  /** The refusal sentence when the last attempt failed. */
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

/**
 * **Unpublish confirm (A10, Figma fq6-unpublish-confirm).**
 *
 * Says what unpublishing does (the update leaves the client portal and goes back to drafts) and —
 * only when the portal access log shows the client already opened it — a violet note naming the
 * client and the day. Escape and "Keep it published" close it without a change.
 */
export function UnpublishUpdateDialog({
  title,
  clientOpened,
  locale,
  unpublishing = false,
  error = null,
  onConfirm,
  onClose,
}: UnpublishUpdateDialogProps) {
  const t = useA10T();
  const titleId = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const latestClose = useRef(onClose);

  useEffect(() => {
    latestClose.current = onClose;
  });
  useEffect(() => {
    sheet.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') latestClose.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="tm-upd-dialog__scrim">
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="tm-upd-dialog"
      >
        <h2 id={titleId} className="tm-upd-dialog__title">
          {t('UnpublishUpdate.title', { title })}
        </h2>
        <p className="tm-upd-dialog__lede">{t('UnpublishUpdate.body')}</p>
        {clientOpened ? (
          <p className="tm-upd-note" role="note">
            <span className="tm-upd-note__mark" aria-hidden="true">
              ◎
            </span>
            {t('UnpublishUpdate.opened', {
              client: clientOpened.clientName,
              date: formatUpdateDay(clientOpened.openedAt, locale),
            })}
          </p>
        ) : null}
        {error ? (
          <InlineAlert tone="danger" title={t('UnpublishUpdate.failed')} live>
            {error}
          </InlineAlert>
        ) : null}
        <div className="tm-upd-actions">
          <Button tone="outline" size="accessible" onClick={onClose} disabled={unpublishing}>
            {t('UnpublishUpdate.keep')}
          </Button>
          <Button
            tone="ink"
            size="accessible"
            loading={unpublishing}
            loadingLabel={t('UnpublishUpdate.unpublishing')}
            onClick={onConfirm}
          >
            {t('UnpublishUpdate.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
