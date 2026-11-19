'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { EditMilestoneDialog, describeA9Error, shortDay } from '../projects/EditMilestoneDialog';
import { browserApiClient } from '../../lib/api/browser-client';
import { getProject } from '../../lib/api/projects';
import { listMembers } from '../../lib/api/members';
import {
  getMilestonePlan,
  milestoneStages,
  type MilestoneDetail,
  type MilestoneStage,
} from '../../lib/api/project-milestones';
import type { ApiClient } from '../../lib/api/client';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../projects/templates-milestones.css';

export interface ProjectMilestonesScreenProps {
  organizationSlug: string;
  organizationName: string;
  projectId: string;
  client?: ApiClient;
}

const PILL_GLYPH: Readonly<Record<MilestoneStage, string>> = {
  done: '✓',
  inProgress: '◷',
  next: '○',
};

/**
 * **Project milestones** (Figma `fq6-milestones`): each milestone with "Done on …" or "Due …", a
 * violet "Client can see" chip when it is on the client timeline, its state pill (Done / In progress
 * / Next) and Edit; "Add milestone" opens the same dialog empty. Reads
 * `GET …/projects/:projectId/milestone-plan` behind `project.manage`.
 */
export function ProjectMilestonesScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: ProjectMilestonesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const [editing, setEditing] = useState<MilestoneDetail | 'new' | null>(null);

  const project = useQuery({
    queryKey: ['project', organizationSlug, projectId],
    queryFn: () => getProject(api, organizationSlug, projectId),
  });
  const plan = useQuery({
    queryKey: ['milestone-plan', organizationSlug, projectId],
    queryFn: () => getMilestonePlan(api, organizationSlug, projectId),
  });
  const members = useQuery({
    queryKey: ['members', organizationSlug, 'a9'],
    queryFn: () => listMembers(api, organizationSlug, { limit: 200 }),
  });

  const milestones = plan.data?.milestones ?? [];
  const stages = milestoneStages(milestones);
  const projectName = project.data?.name ?? '';

  function whenOf(milestone: MilestoneDetail): string {
    if (milestone.status === 'met') {
      return tOr('ProjectMilestones.doneOn', 'Done on {date}').replace(
        '{date}',
        shortDay(milestone.updatedAt.slice(0, 10), locale),
      );
    }
    if (milestone.dueOn === null) return tOr('ProjectMilestones.noDate', 'No date yet');
    return tOr('ProjectMilestones.due', 'Due {date}').replace(
      '{date}',
      shortDay(milestone.dueOn, locale),
    );
  }

  function stageLabel(stage: MilestoneStage): string {
    if (stage === 'done') return tOr('ProjectMilestones.stageDone', 'Done');
    if (stage === 'inProgress') return tOr('ProjectMilestones.stageInProgress', 'In progress');
    return tOr('ProjectMilestones.stageNext', 'Next');
  }

  async function onSaved() {
    setEditing(null);
    await queryClient.invalidateQueries({
      queryKey: ['milestone-plan', organizationSlug, projectId],
    });
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={projectName || tOr('ProjectMilestones.title', 'Milestones')}
      topBar={
        <ProjectTabs
          organizationSlug={organizationSlug}
          projectId={projectId}
          current="milestones"
        />
      }
    >
      <section className="tm-a9-ms" aria-labelledby="tm-a9-ms-title">
        <div className="tm-a9-ms__head">
          <div>
            {projectName ? (
              <p className="tm-a9-ms__eyebrow" dir="auto">
                {projectName}
              </p>
            ) : null}
            <h2 id="tm-a9-ms-title" className="tm-a9-ms__title">
              {tOr('ProjectMilestones.title', 'Milestones')}
            </h2>
          </div>
          <Button
            type="button"
            tone="outline"
            size="feature"
            className="tm-a9-btn"
            // The new milestone's "Show on the client timeline" default comes from the plan's
            // client, read once when the dialog opens: opened before the plan answers, a client
            // project's milestone would start hidden from that client.
            disabled={plan.isPending}
            onClick={() => setEditing('new')}
          >
            {tOr('ProjectMilestones.add', 'Add milestone')}
          </Button>
        </div>

        {plan.isPending ? (
          <LoadingRegion label={tOr('ProjectMilestones.loading', 'Loading the milestones')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {plan.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('ProjectMilestones.loadFailed', 'Couldn’t load the milestones')}
            live
          >
            {describeA9Error(plan.error, tOr)}
          </InlineAlert>
        ) : null}

        {plan.isSuccess && milestones.length === 0 ? (
          <p className="tm-a9-ms__empty">
            {tOr('ProjectMilestones.empty', 'No milestones yet. Add the first one.')}
          </p>
        ) : null}

        {milestones.length > 0 ? (
          <ul className="tm-a9-ms__list">
            {milestones.map((milestone, index) => {
              const stage = stages[index] ?? 'next';
              return (
                <li key={milestone.id} className="tm-a9-ms__row">
                  <span className="tm-a9-ms__text">
                    <span className="tm-a9-ms__name">{milestone.title}</span>
                    <span className="tm-a9-ms__when">{whenOf(milestone)}</span>
                  </span>
                  {milestone.published ? (
                    <span className="tm-a9-tag">
                      {tOr('ProjectMilestones.clientCanSee', 'Client can see')}
                    </span>
                  ) : null}
                  <span className={`tm-a9-pill tm-a9-pill--${stage}`}>
                    <span className="tm-a9-pill__glyph" aria-hidden="true">
                      {PILL_GLYPH[stage]}
                    </span>
                    {stageLabel(stage)}
                  </span>
                  <button
                    type="button"
                    className="tm-a9-edit"
                    aria-label={tOr('ProjectMilestones.editNamed', 'Edit {name}').replace(
                      '{name}',
                      milestone.title,
                    )}
                    onClick={() => setEditing(milestone)}
                  >
                    {tOr('ProjectMilestones.edit', 'Edit')}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      {editing !== null ? (
        <EditMilestoneDialog
          api={api}
          organizationSlug={organizationSlug}
          projectId={projectId}
          milestone={editing === 'new' ? null : editing}
          clientName={plan.data?.clientName ?? null}
          members={members.data?.members ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => void onSaved()}
        />
      ) : null}
    </AppShell>
  );
}
