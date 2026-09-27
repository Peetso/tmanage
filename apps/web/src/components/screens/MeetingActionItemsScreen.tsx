'use client';

import { useMemo, useState } from 'react';
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

export interface MeetingActionItemsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The meeting whose action items to read and manage — carried in the route path. */
  meetingId: string;
  client?: ApiClient;
}

const STATUS_LABELS: Readonly<Record<ActionItemStatus, string>> = {
  open: 'Open',
  done: 'Done',
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
      title="Meeting action items"
      description="What will be done after this meeting, who owns it, and when it is due."
    >
      {meetingId === '' ? (
        <InlineAlert tone="neutral" title="No meeting chosen">
          Open a meeting to see and manage its action items.
        </InlineAlert>
      ) : null}

      {notFound ? (
        <InlineAlert tone="neutral" title="Meeting not found" live>
          This meeting does not exist or you do not have access to it.
        </InlineAlert>
      ) : null}

      {actionItems.isError && !notFound ? (
        <InlineAlert tone="danger" title="Could not load the action items" live>
          {describeError(actionItems.error)}
        </InlineAlert>
      ) : null}

      {meetingId !== '' && !notFound ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-action-items-capture">
          <h2 id="tm-action-items-capture" className="tm-eyebrow">
            Capture an action
          </h2>
          <form className="tm-stack" onSubmit={submitCapture}>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-action-item-title">
                What will be done
              </label>
              <input
                id="tm-action-item-title"
                className="tm-field__control"
                type="text"
                value={title}
                maxLength={500}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. Send the revised deck to the client"
              />
            </div>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-action-item-due">
                Due date (optional)
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
              <InlineAlert tone="danger" title="Could not capture the action" live>
                {capture.error instanceof ApiRequestError
                  ? capture.error.message
                  : 'The API did not answer. Try again.'}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={capture.isPending}
                loadingLabel="Capturing"
                disabled={title.trim() === ''}
              >
                Capture action
              </Button>
            </div>
          </form>
        </section>
      ) : null}

      {meetingId !== '' && actionItems.isPending ? (
        <LoadingRegion label="Loading the action items.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {toggle.isError ? (
        <InlineAlert tone="danger" title="Could not update the action" live>
          {describeError(toggle.error)}
        </InlineAlert>
      ) : null}

      {remove.isError ? (
        <InlineAlert tone="danger" title="Could not remove the action" live>
          {describeError(remove.error)}
        </InlineAlert>
      ) : null}

      {meetingId !== '' && !actionItems.isPending && !actionItems.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No action items yet">
          Nothing has been captured for this meeting yet. Capture an action above.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-stack" aria-label="Meeting action items">
          <ul className="tm-stack tm-list">
            {rows.map((item) => (
              <li key={item.id} className="tm-panel tm-panel--quiet tm-row">
                <span className="tm-table__title">{item.title}</span>
                <StateCapsule state={statusCapsule(item.status)}>
                  {STATUS_LABELS[item.status]}
                </StateCapsule>
                {item.dueOn ? <span className="tm-muted">Due {item.dueOn}</span> : null}
                {item.ownerMembershipId ? <span className="tm-muted">Owner assigned</span> : null}
                <div className="tm-row tm-push-end">
                  <Button
                    type="button"
                    tone="outline"
                    size="accessible"
                    disabled={toggle.isPending}
                    onClick={() =>
                      toggle.mutate({
                        actionItemId: item.id,
                        status: item.status === 'open' ? 'done' : 'open',
                      })
                    }
                  >
                    {item.status === 'open' ? 'Mark done' : 'Reopen'}
                  </Button>
                  <Button
                    type="button"
                    tone="destructive"
                    size="accessible"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(item.id)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </AppShell>
  );
}

/**
 * A distinct word, colour and shape per status so the state never rests on colour alone: done is
 * `done` (✓) and an outstanding action is `waiting` (◷).
 */
function statusCapsule(status: ActionItemStatus): CapsuleState {
  return status === 'done' ? 'done' : 'waiting';
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
