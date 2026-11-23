'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@tmanage/ui';
import type { WorkItemState } from '@tmanage/domain';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import {
  addWorkComment,
  getWorkItemPeople,
  transitionWorkItem,
  type WorkItemSummary,
} from '../../../lib/api/work-items';
import { workItemKeys } from '../../../lib/query-keys';
import { useA6T } from '../DueDatePicker';
import { SendBackDialog, workItemPeopleKey } from '../WorkPeopleBlock';
import { movesTo } from '../stages/stage-model';

export type WorkDecisionKind = 'review' | 'approve' | 'done' | null;

/**
 * Which one decision the header offers (plan §4.3, C27 supervisor rule): a doer of a supervised
 * work sends it for review; a supervisor approves or sends back a work waiting in review; anyone
 * else marks it done. `null` when there is nothing to decide (blocked, done, archived).
 */
export function decisionFor(
  state: WorkItemState,
  supervisorIds: readonly string[],
  viewerId: string | undefined,
  canFinish: boolean,
): WorkDecisionKind {
  // A blocked work is unblocked from its stage; a done or archived one has nothing to decide.
  if (state === 'blocked' || state === 'done' || state === 'archived') return null;
  const supervised = supervisorIds.length > 0;
  const iSupervise = viewerId !== undefined && supervisorIds.includes(viewerId);
  if (state === 'internal_review' && supervised) return iSupervise ? 'approve' : null;
  if (supervised && !iSupervise && movesTo(state, 'internal_review') !== null) return 'review';
  return canFinish ? 'done' : null;
}

/**
 * The header's decision button beside the stage control (Figma `933:95423` "Send for review").
 * "Mark done" goes through the page (its Undo toast); review, approve and send back run here.
 */
export function WorkDecision({
  api,
  organizationSlug,
  item,
  canFinish,
  onDone,
  onChanged,
  onError,
}: {
  api: ApiClient;
  organizationSlug: string;
  item: WorkItemSummary;
  canFinish: boolean;
  onDone: () => void;
  onChanged: (next: WorkItemSummary) => void;
  onError: (message: string) => void;
}) {
  const t = useA6T();
  const describe = useDescribeApiError();
  const queries = useQueryClient();
  const [sendingBack, setSendingBack] = useState(false);
  const people = useQuery({
    queryKey: workItemPeopleKey(organizationSlug, item.id),
    queryFn: () => getWorkItemPeople(api, organizationSlug, item.id),
  });
  const kind = decisionFor(
    item.state,
    people.data?.supervisorUserIds ?? [],
    people.data?.viewerUserId,
    canFinish,
  );

  const settle = (next: WorkItemSummary) => {
    void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
    onChanged(next);
  };

  const review = useMutation({
    mutationFn: async () => {
      const run = movesTo(item.state, 'internal_review');
      let at = item;
      for (const to of [...(run?.before ?? []), 'internal_review' as const]) {
        at = await transitionWorkItem(api, organizationSlug, item.id, { version: at.version, to });
      }
      return at;
    },
    onSuccess: settle,
    onError: (error) => onError(describe(error)),
  });

  const decide = useMutation({
    mutationFn: async ({ approve, note }: { approve: boolean; note: string }) => {
      const next = await transitionWorkItem(api, organizationSlug, item.id, {
        version: item.version,
        to: approve ? 'done' : 'in_progress',
        facts:
          approve && item.ownerUserId !== null
            ? { ownerId: item.ownerUserId, completedAt: new Date().toISOString() }
            : {},
      });
      if (!approve && note.trim() !== '') {
        await addWorkComment(api, organizationSlug, item.id, { body: note.trim() });
      }
      return next;
    },
    onSuccess: (next) => {
      setSendingBack(false);
      settle(next);
    },
    onError: (error) => onError(describe(error)),
  });

  if (kind === null) return null;
  if (kind === 'approve') {
    return (
      <>
        <Button
          tone="outline"
          size="header"
          loading={decide.isPending}
          onClick={() => setSendingBack(true)}
        >
          {t('WorkPeople.sendBack')}
        </Button>
        <Button
          tone="lime"
          size="header"
          loading={decide.isPending}
          onClick={() => decide.mutate({ approve: true, note: '' })}
        >
          {t('WorkPeople.approve')}
        </Button>
        {sendingBack ? (
          <SendBackDialog
            saving={decide.isPending}
            onSend={(note) => decide.mutate({ approve: false, note })}
            onClose={() => setSendingBack(false)}
          />
        ) : null}
      </>
    );
  }
  return (
    <Button
      tone="outline"
      size="header"
      loading={review.isPending}
      onClick={() => (kind === 'review' ? review.mutate() : onDone())}
    >
      {kind === 'review' ? t('WorkPage.sendForReview') : t('WorkDetail.markDone')}
    </Button>
  );
}
