'use client';

import { useRef, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { browserApiClient } from '../../lib/api/browser-client';
import { createFocusBlock, deleteFocusBlock, listFocusBlocks } from '../../lib/api/focus-blocks';
import type { FocusBlockView } from '../../lib/api/focus-blocks';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { CalendarHeaderActions, CalendarSubnav, whenLabel } from './MeetingsScreen';
import '../../styles/screens/calendar.css';
import { appLocale } from '../../lib/i18n/app-locale';

export interface FocusBlocksScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The list window: from the start of today through 30 days out, so a member sees their upcoming blocks. */
function listWindow(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Render an ISO instant as a readable local date-time, falling back to the raw value. */
function formatInstant(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString(appLocale());
}

/**
 * **Calendar focus blocks (module Calendar, CAL-04 "Focus block", x255).**
 *
 * A member protects time on their own calendar: they create a block (a start, an end and a short
 * title), see their upcoming blocks, and delete one. Persisted behind `work.read`, scoped to the
 * caller's own membership by the server — a member never sees or removes another's blocks.
 */
export function FocusBlocksScreen({
  organizationSlug,
  organizationName,
  client,
}: FocusBlocksScreenProps) {
  const errorMessage = useDescribeApiError(OFFLINE_LINES);
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const window = useMemo(listWindow, []);

  const blocks = useQuery({
    queryKey: ['focus-blocks', organizationSlug, window.from, window.to],
    queryFn: () => listFocusBlocks(api, organizationSlug, window.from, window.to),
  });

  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [title, setTitle] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const invalidate = () =>
    queries.invalidateQueries({ queryKey: ['focus-blocks', organizationSlug] });

  const create = useMutation({
    mutationFn: (): Promise<FocusBlockView> =>
      createFocusBlock(api, organizationSlug, {
        // `datetime-local` yields a wall-clock string with no zone; the Date constructor reads it as
        // local and toISOString normalises it to the instant the API stores.
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        title,
      }),
    onSuccess: () => {
      setStartsAt('');
      setEndsAt('');
      setTitle('');
      void invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string): Promise<void> => deleteFocusBlock(api, organizationSlug, id),
    onSuccess: () => void invalidate(),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    if (!startsAt || !endsAt || title.trim().length === 0) {
      setFormError(t('FocusBlocksScreen.allFieldsRequired'));
      return;
    }
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      setFormError(t('FocusBlocksScreen.endAfterStart'));
      return;
    }
    create.mutate();
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title={t('FocusBlocksScreen.title')}
      eyebrow={t('FocusBlocksScreen.eyebrow')}
      actions={<CalendarHeaderActions organizationSlug={organizationSlug} current="none" />}
    >
      <div className="tm-cal">
        <CalendarSubnav organizationSlug={organizationSlug} current="focus-blocks" />

        <div className="tm-cal-body">
          <div className="tm-cal-main">
            {blocks.isPending ? (
              <LoadingRegion label={t('FocusBlocksScreen.loading')}>
                <Skeleton />
              </LoadingRegion>
            ) : blocks.isError ? (
              <InlineAlert tone="danger" title={t('FocusBlocksScreen.loadErrorTitle')}>
                {errorMessage(blocks.error)}
              </InlineAlert>
            ) : blocks.data.length === 0 ? (
              <TeachingEmptyState
                title={t('FocusBlocksScreen.emptyTitle')}
                explanation={t('teachEmpty.focusBlocksBody')}
                action={
                  canUse('work.read') ? (
                    <Button
                      tone="lime"
                      size="accessible"
                      onClick={() => focusFirstField(firstStep.current)}
                    >
                      {t('teachEmpty.focusBlocksAction')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="tm-cal-sheet">
                <table>
                  <caption className="tm-visually-hidden">
                    {`${t('FocusBlocksScreen.captionPrefix')} ${blocks.data.length} ${t('FocusBlocksScreen.captionSuffix')}`}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('FocusBlocksScreen.colTime')}</th>
                      <th scope="col">{t('FocusBlocksScreen.colWhat')}</th>
                      <th scope="col">{t('FocusBlocksScreen.colKind')}</th>
                      <th scope="col">
                        <span className="tm-visually-hidden">
                          {t('FocusBlocksScreen.colActions')}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody aria-label={t('FocusBlocksScreen.tableLabel')}>
                    {blocks.data.map((block) => (
                      <tr key={block.id}>
                        <td className="tm-cal-sheet__time">
                          <time dateTime={block.startsAt}>{whenLabel(block.startsAt)}</time>
                        </td>
                        <th scope="row" className="tm-cal-sheet__what">
                          {block.title}
                          <span className="tm-cal-sheet__sub">
                            {formatInstant(block.startsAt)} — {formatInstant(block.endsAt)}
                          </span>
                        </th>
                        <td className="tm-cal-sheet__kind">
                          {`${t('FocusBlocksScreen.kindPrefix')} ${durationMinutes(block.startsAt, block.endsAt)} ${t('FocusBlocksScreen.minUnit')}`}
                        </td>
                        <td className="tm-cal-sheet__end">
                          <Button
                            type="button"
                            tone="text"
                            size="compact"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(block.id)}
                          >
                            {t('FocusBlocksScreen.remove')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {remove.isError ? (
              <InlineAlert tone="danger" title={t('FocusBlocksScreen.removeErrorTitle')}>
                {errorMessage(remove.error)}
              </InlineAlert>
            ) : null}
          </div>

          <div className="tm-cal-side">
            <form
              noValidate
              ref={firstStep}
              className="tm-cal-card"
              aria-labelledby="tm-focus-heading"
              onSubmit={submit}
            >
              <h2 id="tm-focus-heading" className="tm-cal-eyebrow">
                {t('FocusBlocksScreen.newHeading')}
              </h2>
              <p className="tm-cal-card__title">{t('FocusBlocksScreen.newSubtitle')}</p>

              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-focus-title">
                  {t('FocusBlocksScreen.titleLabel')}
                </label>
                <input
                  id="tm-focus-title"
                  className="tm-field__control"
                  type="text"
                  value={title}
                  placeholder={t('FocusBlocksScreen.titlePlaceholder')}
                  maxLength={200}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>

              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-focus-start">
                  {t('FocusBlocksScreen.startLabel')}
                </label>
                <input
                  id="tm-focus-start"
                  className="tm-field__control"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(event) => setStartsAt(event.target.value)}
                />
              </div>

              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-focus-end">
                  {t('FocusBlocksScreen.endLabel')}
                </label>
                <input
                  id="tm-focus-end"
                  className="tm-field__control"
                  type="datetime-local"
                  value={endsAt}
                  onChange={(event) => setEndsAt(event.target.value)}
                />
              </div>

              {formError ? (
                <InlineAlert tone="danger" title={t('FocusBlocksScreen.checkTitle')}>
                  {formError}
                </InlineAlert>
              ) : null}

              {create.isError ? (
                <InlineAlert tone="danger" title={t('FocusBlocksScreen.createErrorTitle')}>
                  {errorMessage(create.error)}
                </InlineAlert>
              ) : null}

              <Button type="submit" disabled={create.isPending}>
                {create.isPending
                  ? t('FocusBlocksScreen.creating')
                  : t('FocusBlocksScreen.createButton')}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/** Whole minutes between two instants, for the "Focus · 90 min" kind cell. */
function durationMinutes(startsAt: string, endsAt: string): number {
  const ms = Date.parse(endsAt) - Date.parse(startsAt);
  return Number.isNaN(ms) ? 0 : Math.max(0, Math.round(ms / 60_000));
}
