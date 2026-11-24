'use client';

import { useState } from 'react';
import { Button, InfoButton, InlineAlert, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../../admin/SettingsShell';
import type { ApiClient } from '../../../lib/api/client';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { StageSetView } from '../../../lib/api/work-stages';
import { useA6T } from '../DueDatePicker';
import { ChevronDownIcon } from '../work-icons';
import { editorSets, projectsKey } from './stage-editor-model';
import { NewStageSetDialog } from './NewStageSetDialog';
import { StageSetEditor } from './StageSetEditor';
import { useStageSets } from './use-work-stages';
import './stages-editor.css';

export interface StagesSettingsScreenProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  /** `?new=1`: open New stage set at once (the work page's set picker links here). */
  readonly startNew?: boolean;
  /** `?set=<id>`: the set to open (a project's "Edit this stage set"). */
  readonly setId?: string;
  readonly client?: ApiClient;
}

/**
 * The line under each set in the list (Figma W7: "Workspace default", "2 projects"): what uses it.
 * A set no project points at yet says how many stages it has.
 */
function listNote(set: StageSetView, t: ReturnType<typeof useA6T>): string {
  if (set.isDefault) return t('WorkStages.workspaceDefault');
  if (set.projectId !== null) return t('WorkStages.editor.projectSet');
  return set.projectCount > 0
    ? t(projectsKey(set.projectCount), { count: set.projectCount })
    : t('WorkStages.editor.stagesCount', { count: set.stages.length });
}

/**
 * **Settings → Stages** (W-WEB-5; Figma W7 `937:99028` EN, `937:99338` AR, phone `937:99538` /
 * `937:99738`, info popover `937:99739`). The workspace's stage sets on the start side, the chosen
 * set in the editor beside it; on phone the list, then one set with "‹ Stages" back. "New stage
 * set" in the header opens the W8 dialog. While no set is the workspace default, the built-in
 * stages are listed first, read-only.
 *
 * Reading is `work.read`; changing a workspace set is the owner's and admins' (`org.manage`), a
 * project's own set its managers' (`project.manage`). The API decides each write; a refused one is
 * named in the editor.
 */
export function StagesSettingsScreen({
  organizationSlug,
  organizationName,
  startNew = false,
  setId,
  client,
}: StagesSettingsScreenProps) {
  const t = useA6T();
  const api = client ?? browserApiClient();
  const stored = useStageSets(api, organizationSlug);
  const [selected, setSelected] = useState<string | null>(setId ?? null);
  const [view, setView] = useState<'list' | 'set'>(setId ? 'set' : 'list');
  const [creating, setCreating] = useState(startNew);

  const sets = stored.data ? editorSets(stored.data) : [];
  const current =
    sets.find((set) => set.id === selected) ?? sets.find((set) => set.isDefault) ?? sets[0] ?? null;

  function open(id: string) {
    setSelected(id);
    setView('set');
  }

  return (
    <SettingsShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="stages"
      // Figma WV2-07 phone (WX1, must-fix 4): an opened set draws "‹ Stages" and its name, so
      // the page title is not drawn above them.
      phoneHeader={view === 'set' ? 'hide' : 'show'}
      title={t('WorkStages.editor.title')}
      titleMeta={
        <InfoButton
          className="tm-stg-info"
          title={t('WorkStages.editor.title')}
          label={t('WorkStages.editor.infoLabel')}
        >
          {t('WorkStages.editor.info')}
        </InfoButton>
      }
      actions={
        <Button tone="lime" size="header" onClick={() => setCreating(true)}>
          {t('WorkStages.newSet')}
        </Button>
      }
      {...(client ? { client } : {})}
    >
      <div className="tm-stg-page" data-view={view}>
        {stored.isPending ? (
          <div className="tm-stg-page__loading" aria-busy="true">
            <span className="tm-visually-hidden">{t('WorkStages.editor.loading')}</span>
            <Skeleton height="var(--app-row)" />
            <Skeleton height="var(--app-row)" />
            <Skeleton height="var(--app-row)" />
          </div>
        ) : stored.isError ? (
          <InlineAlert tone="danger" title={t('WorkStages.editor.loadFailed')} live>
            <Button tone="outline" size="header" onClick={() => void stored.refetch()}>
              {t('WorkStages.editor.retry')}
            </Button>
          </InlineAlert>
        ) : (
          <>
            <nav className="tm-stg-list" aria-label={t('WorkStages.editor.listLabel')}>
              <ul>
                {sets.map((set) => (
                  <li key={set.id}>
                    <button
                      type="button"
                      className="tm-stg-list__item"
                      aria-current={set.id === current?.id ? 'true' : undefined}
                      onClick={() => open(set.id)}
                    >
                      <span className="tm-stg-list__name">
                        <bdi>{set.isBuiltIn ? t('WorkStages.builtInSet') : set.name}</bdi>
                      </span>
                      <span className="tm-stg-list__note">{listNote(set, t)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            {current ? (
              <StageSetEditor
                key={current.id}
                api={api}
                organizationSlug={organizationSlug}
                set={current}
                sets={sets}
                onSelect={open}
                onDeleted={() => {
                  setSelected(null);
                  setView('list');
                }}
                back={
                  <button type="button" className="tm-stg-back" onClick={() => setView('list')}>
                    <span className="tm-stg-back__icon" aria-hidden="true">
                      <ChevronDownIcon />
                    </span>
                    {t('WorkStages.editor.title')}
                  </button>
                }
              />
            ) : null}
          </>
        )}
      </div>
      {creating ? (
        <NewStageSetDialog
          api={api}
          organizationSlug={organizationSlug}
          sets={sets}
          onClose={() => setCreating(false)}
          onCreated={(set) => {
            setCreating(false);
            open(set.id);
          }}
        />
      ) : null}
    </SettingsShell>
  );
}
