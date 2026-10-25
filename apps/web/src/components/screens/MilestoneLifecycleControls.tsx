'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, StateCapsule } from '@tmanage/ui';
import {
  completeProjectMilestone,
  editProjectMilestone,
  type MilestoneEdit,
  type MilestoneStatus,
} from '../../lib/api/portal';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';

/** `project_milestones.title` is VARCHAR(300). */
const MAX_MILESTONE_TITLE_LENGTH = 300;

function milestoneCapsuleState(status: MilestoneStatus): 'done' | 'blocked' | 'future' {
  if (status === 'met') return 'done';
  if (status === 'missed') return 'blocked';
  return 'future';
}

export interface MilestoneLifecycleControlsProps {
  api: ApiClient;
  organizationSlug: string;
  projectId: string;
  milestoneId: string;
  /** The current values, used to seed the edit fields. */
  title: string;
  dueOn: string | null;
  status: MilestoneStatus;
  /** Invoked with the updated milestone after a successful edit or completion. */
  onChange?: (milestone: MilestoneEdit) => void;
}

/**
 * SEC / Portal milestone lifecycle (x202) — the internal edit and complete controls.
 *
 * A distinct component from x139's `MilestoneComposer` (create surface): this edits or completes an
 * *existing* milestone. Both writes are behind `project.manage` — the API refuses anyone else, and
 * a client never reaches this internal path. On success the client-facing portal query and the
 * internal list are invalidated so an open portal tab picks the change up.
 *
 * "Complete" sets `status = met` — a milestone is complete when it has been met; the completion date
 * is the milestone's `updatedAt` (there is no separate completed-at field).
 */
export function MilestoneLifecycleControls({
  api,
  organizationSlug,
  projectId,
  milestoneId,
  title,
  dueOn,
  status,
  onChange,
}: MilestoneLifecycleControlsProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const queries = useQueryClient();
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftDueOn, setDraftDueOn] = useState(dueOn ?? '');

  function invalidate(updated: MilestoneEdit) {
    void queries.invalidateQueries({
      queryKey: ['project-milestones', organizationSlug, projectId],
    });
    void queries.invalidateQueries({
      queryKey: ['portal-milestones', organizationSlug, projectId],
    });
    onChange?.(updated);
  }

  const edit = useMutation({
    mutationFn: () =>
      editProjectMilestone(api, organizationSlug, projectId, milestoneId, {
        title: draftTitle.trim(),
        dueOn: draftDueOn === '' ? null : draftDueOn,
      }),
    onSuccess: invalidate,
  });

  const complete = useMutation({
    mutationFn: () => completeProjectMilestone(api, organizationSlug, projectId, milestoneId),
    onSuccess: invalidate,
  });

  const canEdit = draftTitle.trim() !== '' && !edit.isPending;
  const isComplete = status === 'met';

  return (
    <div className="tm-stack tm-stack--tight">
      <div className="tm-row tm-row--wrap">
        <StateCapsule state={milestoneCapsuleState(status)}>{status}</StateCapsule>
        <Button
          type="button"
          onClick={() => complete.mutate()}
          disabled={complete.isPending || isComplete}
          className="tm-push-end"
        >
          {isComplete
            ? t('MilestoneLifecycleControls.completed')
            : t('MilestoneLifecycleControls.markComplete')}
        </Button>
      </div>

      {edit.isError ? (
        <InlineAlert tone="danger" title={t('MilestoneLifecycleControls.editError')} live>
          {describe(edit.error)}
        </InlineAlert>
      ) : null}
      {complete.isError ? (
        <InlineAlert tone="danger" title={t('MilestoneLifecycleControls.completeError')} live>
          {describe(complete.error)}
        </InlineAlert>
      ) : null}

      <form
        className="tm-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (canEdit) edit.mutate();
        }}
      >
        <div className="tm-field">
          <label className="tm-field__label" htmlFor={`tm-milestone-title-${milestoneId}`}>
            {t('MilestoneLifecycleControls.title')}
          </label>
          <input
            id={`tm-milestone-title-${milestoneId}`}
            className="tm-field__control"
            value={draftTitle}
            maxLength={MAX_MILESTONE_TITLE_LENGTH}
            onChange={(event) => setDraftTitle(event.target.value)}
          />
        </div>
        <div className="tm-field">
          <label className="tm-field__label" htmlFor={`tm-milestone-due-${milestoneId}`}>
            {t('MilestoneLifecycleControls.dueDate')}
          </label>
          <input
            id={`tm-milestone-due-${milestoneId}`}
            className="tm-field__control"
            type="date"
            value={draftDueOn}
            onChange={(event) => setDraftDueOn(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={!canEdit}>
          {edit.isPending
            ? t('MilestoneLifecycleControls.saving')
            : t('MilestoneLifecycleControls.saveChanges')}
        </Button>
      </form>
    </div>
  );
}
