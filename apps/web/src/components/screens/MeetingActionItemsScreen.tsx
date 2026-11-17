'use client';

import { useRef, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createMeetingActionItem,
  deleteMeetingActionItem,
  listMeetingActionItems,
  updateMeetingActionItem,
} from '../../lib/api/meeting-action-items';
import type { ActionItemStatus } from '../../lib/api/meeting-action-items';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { MeetingBackLink, MeetingHeaderActions } from './MeetingsScreen';
import '../../styles/screens/calendar.css';

export interface MeetingActionItemsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The meeting whose action items to read and manage — carried in the route path. */
  meetingId: string;
  client?: ApiClient;
}

const STATUS_LABEL_KEYS: Readonly<Record<ActionItemStatus, MessageKey>> = {
  open: 'MeetingActionItemsScreen.statusOpen',
  done: 'MeetingActionItemsScreen.statusDone',
};

/**
 * **CAL / MTG-03 — a meeting's action items (x266).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Calendar asks that "a meeting closes with linked
 * decisions and actions"; `0033_meeting_notes` captured the notes and decisions but deferred the
 * linked *actions* explicitly ("no linked actions … the next slice"). This is that surface: against
 * one meeting, capture what will be done, list the actions, toggle each open/done, and remove one.
 *
 * ## What it draws, and what it cannot
 *
 * - **Capturing an action.** A title (required) and an optional due date post behind `meeting.write`.
 *   A refusal is shown in the form, the list untouched.
 * - **The actions.** Each row shows its title, due date and status ({@link StateCapsule}), a toggle
 *   between open and done (→ `PATCH …/action-items/:id`), and a remove control (→ `DELETE`).
 * - **Assigning an owner by name is not here.** The action item stores an `ownerMembershipId` and the
 *   API accepts one, but the member directory deliberately hides the membership id (it is its keyset
 *   cursor), so a name→membership picker is a separate decision deferred to a later slice — this
 *   screen surfaces an owner when one is set rather than fabricating a picker over an opaque id.
 *
 * A meeting id is required, and the API resolves it tenant-scoped before the relation check, so an
 * unknown or cross-tenant id comes back 404 and the screen shows a not-found state — never an empty
 * list that would confirm the meeting exists.
 */
export function MeetingActionItemsScreen({
  organizationSlug,
  organizationName,
  meetingId,
  client,
}: MeetingActionItemsScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);

  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');

  const invalidateList = () =>
    void queries.invalidateQueries({
      queryKey: ['meeting-action-items', organizationSlug, meetingId],
    });

  const actionItems = useQuery({
    queryKey: ['meeting-action-items', organizationSlug, meetingId],
    queryFn: () => listMeetingActionItems(api, organizationSlug, meetingId),
    enabled: meetingId !== '',
  });

  const rows = useMemo(() => actionItems.data?.actionItems ?? [], [actionItems.data]);

  const capture = useMutation({
    mutationFn: () =>
      createMeetingActionItem(api, organizationSlug, meetingId, {
        title: title.trim(),
        ...(dueOn !== '' ? { dueOn } : {}),
      }),
    onSuccess: () => {
      setTitle('');
      setDueOn('');
      invalidateList();
    },
  });

  const toggle = useMutation({
    mutationFn: (input: { actionItemId: string; status: ActionItemStatus }) =>
      updateMeetingActionItem(api, organizationSlug, meetingId, input.actionItemId, {
        status: input.status,
      }),
    onSuccess: invalidateList,
  });

  const remove = useMutation({
    mutationFn: (actionItemId: string) =>
      deleteMeetingActionItem(api, organizationSlug, meetingId, actionItemId),
    onSuccess: invalidateList,
  });

  const notFound =
    actionItems.isError &&
    actionItems.error instanceof ApiRequestError &&
    actionItems.error.status === 404;

  function submitCapture(event: FormEvent) {
    event.preventDefault();
    if (title.trim() === '') return;
    capture.mutate();
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title={t('MeetingActionItemsScreen.title')}
      eyebrow={t('MeetingActionItemsScreen.eyebrow')}
      actions={
        <MeetingHeaderActions
          organizationSlug={organizationSlug}
          meetingId={notFound ? '' : meetingId}
          current="action-items"
        />
      }
    >
      <div className="tm-cal">
        <MeetingBackLink organizationSlug={organizationSlug} />

        {meetingId === '' ? (
          <InlineAlert tone="neutral" title={t('MeetingActionItemsScreen.noMeetingTitle')}>
            {t('MeetingActionItemsScreen.noMeetingBody')}
          </InlineAlert>
        ) : null}

        {notFound ? (
          <InlineAlert tone="neutral" title={t('MeetingActionItemsScreen.notFoundTitle')} live>
            {t('MeetingActionItemsScreen.notFoundBody')}
          </InlineAlert>
        ) : null}

        {actionItems.isError && !notFound ? (
          <InlineAlert tone="danger" title={t('MeetingActionItemsScreen.loadErrorTitle')} live>
            {describeError(t, actionItems.error)}
          </InlineAlert>
        ) : null}

        {meetingId !== '' && !notFound ? (
          <div className="tm-cal-body">
            <div className="tm-cal-main">
              {actionItems.isPending ? (
                <LoadingRegion label={t('MeetingActionItemsScreen.loadingLabel')}>
                  <Skeleton height="var(--row)" />
                  <Skeleton height="var(--row)" />
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : null}

              {toggle.isError ? (
                <InlineAlert
                  tone="danger"
                  title={t('MeetingActionItemsScreen.toggleErrorTitle')}
                  live
                >
                  {describeError(t, toggle.error)}
                </InlineAlert>
              ) : null}

              {remove.isError ? (
                <InlineAlert
                  tone="danger"
                  title={t('MeetingActionItemsScreen.removeErrorTitle')}
                  live
                >
                  {describeError(t, remove.error)}
                </InlineAlert>
              ) : null}

              {!actionItems.isPending && !actionItems.isError && rows.length === 0 ? (
                <TeachingEmptyState
                  title={t('MeetingActionItemsScreen.emptyTitle')}
                  explanation={t('teachEmpty.meetingActionsBody')}
                  action={
                    canUse('meeting.write') ? (
                      <Button
                        tone="lime"
                        size="accessible"
                        onClick={() => focusFirstField(firstStep.current)}
                      >
                        {t('teachEmpty.meetingActionsAction')}
                      </Button>
                    ) : undefined
                  }
                />
              ) : null}

              {rows.length > 0 ? (
                <section
                  className="tm-cal-card"
                  aria-label={t('MeetingActionItemsScreen.listAria')}
                >
                  <p className="tm-cal-eyebrow">
                    {t('MeetingActionItemsScreen.actionsLabel')} · {rows.length} ·{' '}
                    {rows.filter((item) => item.status === 'open').length}{' '}
                    {t('MeetingActionItemsScreen.openCountLabel')}
                  </p>
                  <ul className="tm-cal-items">
                    {rows.map((item) => (
                      <li key={item.id} className="tm-cal-item">
                        <span
                          className={
                            item.status === 'done' ? 'tm-cal-orb' : 'tm-cal-orb tm-cal-orb--empty'
                          }
                          aria-hidden="true"
                        >
                          {item.status === 'done' ? '✓' : ''}
                        </span>
                        <span className="tm-cal-item__body">
                          <span className="tm-cal-item__title">{item.title}</span>
                          <span className="tm-cal-item__meta">
                            {item.dueOn
                              ? `${t('MeetingActionItemsScreen.due')} ${item.dueOn}`
                              : t('MeetingActionItemsScreen.noDateYet')}
                            {item.ownerMembershipId
                              ? ` · ${t('MeetingActionItemsScreen.ownerAssigned')}`
                              : ''}
                          </span>
                        </span>
                        <span className="tm-cal-item__end">
                          <StateCapsule state={statusCapsule(item.status)}>
                            {t(STATUS_LABEL_KEYS[item.status])}
                          </StateCapsule>
                          <Button
                            type="button"
                            tone="outline"
                            size="compact"
                            disabled={toggle.isPending}
                            onClick={() =>
                              toggle.mutate({
                                actionItemId: item.id,
                                status: item.status === 'open' ? 'done' : 'open',
                              })
                            }
                          >
                            {item.status === 'open'
                              ? t('MeetingActionItemsScreen.markDone')
                              : t('MeetingActionItemsScreen.reopen')}
                          </Button>
                          <Button
                            type="button"
                            tone="destructive"
                            size="compact"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(item.id)}
                          >
                            {t('MeetingActionItemsScreen.remove')}
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>

            <div className="tm-cal-side">
              <section className="tm-cal-card" aria-labelledby="tm-action-items-capture">
                <h2 id="tm-action-items-capture" className="tm-cal-eyebrow">
                  {t('MeetingActionItemsScreen.captureHeading')}
                </h2>
                <form ref={firstStep} className="tm-cal-form" onSubmit={submitCapture}>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-action-item-title">
                      {t('MeetingActionItemsScreen.captureTitleLabel')}
                    </label>
                    <input
                      id="tm-action-item-title"
                      className="tm-field__control"
                      type="text"
                      value={title}
                      maxLength={500}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder={t('MeetingActionItemsScreen.captureTitlePlaceholder')}
                    />
                  </div>
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-action-item-due">
                      {t('MeetingActionItemsScreen.captureDueLabel')}
                    </label>
                    <input
                      id="tm-action-item-due"
                      className="tm-field__control"
                      type="date"
                      value={dueOn}
                      onChange={(event) => setDueOn(event.target.value)}
                    />
                  </div>

                  {capture.isError ? (
                    <InlineAlert
                      tone="danger"
                      title={t('MeetingActionItemsScreen.captureErrorTitle')}
                      live
                    >
                      {capture.error instanceof ApiRequestError
                        ? capture.error.message
                        : t('MeetingActionItemsScreen.apiNoAnswer')}
                    </InlineAlert>
                  ) : null}

                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    loading={capture.isPending}
                    loadingLabel={t('MeetingActionItemsScreen.capturingLabel')}
                    disabled={title.trim() === ''}
                  >
                    {t('MeetingActionItemsScreen.captureSubmit')}
                  </Button>
                </form>
              </section>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

function statusCapsule(status: ActionItemStatus): CapsuleState {
  return status === 'done' ? 'done' : 'waiting';
}

function describeError(t: (key: MessageKey) => string, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('MeetingActionItemsScreen.errorNetwork');
  return t('MeetingActionItemsScreen.errorGeneric');
}
