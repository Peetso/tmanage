'use client';

import { useId, useState } from 'react';
import type { ApiClient } from '../../../lib/api/client';
import {
  addStage,
  reorderStages,
  updateStage,
  type StageGroup,
  type StageSetView,
  type StageView,
} from '../../../lib/api/work-stages';
import { useA6T } from '../DueDatePicker';
import { DragIcon, LockIcon, PlusIcon } from '../work-icons';
import {
  addPosition,
  canAddTo,
  checkStageName,
  DELETE_BLOCK_KEY,
  deleteBlock,
  NAME_ERROR_KEY,
  orderAfterDrop,
  orderAfterStep,
  stagesInGroup,
} from './stage-editor-model';
import { GROUP_KEY, GROUP_STATE, groupColorVar, stageColorVar } from './stage-model';
import { StageNameField } from './StageNameField';
import { StageMoreMenu } from './StageMoreMenu';
import { StageCapsule } from './WorkStageControl';
import type { StageSetWrites } from './use-stage-editor';

/** Focus the ⋯ of a stage after its row moved (a moved node loses focus in the browser). */
function focusRowMenu(stageId: string) {
  requestAnimationFrame(() => {
    const row = Array.from(document.querySelectorAll<HTMLElement>('[data-stage-id]')).find(
      (node) => node.dataset['stageId'] === stageId,
    );
    row?.querySelector<HTMLButtonElement>('.tm-stg-more__button')?.focus();
  });
}

/**
 * One of the four fixed groups in the stages editor (Figma W7 `937:99028`): its stages in order,
 * each renamable (typed or dictated), movable up and down (menu, and the drag handle for a
 * pointer), and deletable when the set rules allow; then "Add stage", or "One Done stage" for
 * Done. A group with no stage says that work skips it (W9 `939:100522`).
 */
export function StageGroupCard({
  api,
  organizationSlug,
  set,
  group,
  editable,
  writes,
  stageName,
  onDelete,
}: {
  api: ApiClient;
  organizationSlug: string;
  set: StageSetView;
  group: StageGroup;
  /** The built-in stages are read-only (copy them to change names). */
  editable: boolean;
  writes: StageSetWrites;
  stageName: (stage: StageView) => string;
  onDelete: (stage: StageView) => void;
}) {
  const t = useA6T();
  const headingId = useId();
  const stages = stagesInGroup(set, group);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState<string | null>(null);

  async function saveRename(stage: StageView) {
    if (!renaming) return;
    if (renaming.value.trim() === stage.name) {
      setRenaming(null);
      return;
    }
    const checked = checkStageName(renaming.value, set, stage.id);
    if ('error' in checked) {
      setError(t(NAME_ERROR_KEY[checked.error]));
      return;
    }
    const saved = await writes.run(() =>
      updateStage(api, organizationSlug, set.id, stage.id, { name: checked.name }),
    );
    if (saved !== null) {
      setRenaming(null);
      setError(undefined);
    }
  }

  async function saveAdd() {
    if (adding === null) return;
    if (adding.trim() === '') {
      setAdding(null);
      setError(undefined);
      return;
    }
    const checked = checkStageName(adding, set);
    if ('error' in checked) {
      setError(t(NAME_ERROR_KEY[checked.error]));
      return;
    }
    const saved = await writes.run(() =>
      addStage(api, organizationSlug, set.id, {
        name: checked.name,
        stateKey: GROUP_STATE[group],
        position: addPosition(set, group),
      }),
    );
    if (saved !== null) {
      setAdding(null);
      setError(undefined);
    }
  }

  async function reorder(stageId: string, ids: readonly string[] | null) {
    if (ids === null) return;
    await writes.run(() => reorderStages(api, organizationSlug, set.id, ids));
    focusRowMenu(stageId);
  }

  return (
    <section className="tm-stg-group" aria-labelledby={headingId}>
      <header className="tm-stg-group__head">
        <span
          className="tm-wk-stage__dot"
          style={{ background: groupColorVar(group) }}
          aria-hidden="true"
        />
        <h3 id={headingId} className="tm-stg-group__title">
          {t(GROUP_KEY[group])}
        </h3>
        <span className="tm-stg-group__count">
          <span className="tm-visually-hidden">{t('WorkStages.editor.stageCount')} </span>
          {stages.length}
        </span>
      </header>
      {stages.length === 0 ? (
        <p className="tm-stg-group__empty">{t('WorkStages.editor.emptyGroup')}</p>
      ) : (
        <ul className="tm-stg-group__list">
          {stages.map((stage, index) => {
            const name = stageName(stage);
            if (renaming?.id === stage.id) {
              return (
                <li key={stage.id} className="tm-stg-row" data-editing data-stage-id={stage.id}>
                  <StageNameField
                    api={api}
                    organizationSlug={organizationSlug}
                    label={t('WorkStages.editor.stageNameLabel')}
                    value={renaming.value}
                    onChange={(value) => {
                      setRenaming({ id: stage.id, value });
                      setError(undefined);
                    }}
                    onSave={() => void saveRename(stage)}
                    onCancel={() => {
                      setRenaming(null);
                      setError(undefined);
                    }}
                    error={error}
                    lead={
                      <span
                        className="tm-wk-stage__dot"
                        style={{ background: stageColorVar(stage) }}
                        aria-hidden="true"
                      />
                    }
                  />
                </li>
              );
            }
            const blocked = deleteBlock(set, stage);
            return (
              <li
                key={stage.id}
                className="tm-stg-row"
                data-stage-id={stage.id}
                data-dragging={dragging === stage.id || undefined}
                draggable={editable && !writes.pending}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', stage.id);
                  setDragging(stage.id);
                }}
                onDragEnd={() => setDragging(null)}
                onDragOver={(event) => {
                  if (dragging !== null) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const moving = dragging;
                  setDragging(null);
                  if (moving) void reorder(moving, orderAfterDrop(set, moving, stage.id));
                }}
              >
                {editable ? (
                  <span className="tm-stg-row__handle" aria-hidden="true">
                    <DragIcon />
                  </span>
                ) : null}
                <span className="tm-stg-row__name">
                  <StageCapsule stage={stage} name={name} />
                </span>
                {editable ? (
                  <StageMoreMenu
                    label={t('WorkStages.editor.moreFor', { stage: name })}
                    entries={[
                      {
                        id: 'rename',
                        label: t('WorkStages.editor.rename'),
                        onSelect: () => {
                          setAdding(null);
                          setError(undefined);
                          setRenaming({ id: stage.id, value: stage.name });
                        },
                      },
                      {
                        id: 'up',
                        label: t('WorkStages.editor.moveUp'),
                        disabled: index === 0,
                        onSelect: () => void reorder(stage.id, orderAfterStep(set, stage.id, -1)),
                      },
                      {
                        id: 'down',
                        label: t('WorkStages.editor.moveDown'),
                        disabled: index === stages.length - 1,
                        onSelect: () => void reorder(stage.id, orderAfterStep(set, stage.id, 1)),
                      },
                      {
                        id: 'delete',
                        label: t('WorkStages.editor.delete'),
                        danger: true,
                        blockedBy: blocked ? t(DELETE_BLOCK_KEY[blocked]) : undefined,
                        onSelect: () => onDelete(stage),
                      },
                    ]}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {!editable ? null : group === 'done' ? (
        <p className="tm-stg-group__lock">
          <LockIcon />
          {t('WorkStages.editor.oneDone')}
        </p>
      ) : adding !== null ? (
        <StageNameField
          api={api}
          organizationSlug={organizationSlug}
          label={t('WorkStages.editor.newStageLabel', { group: t(GROUP_KEY[group]) })}
          value={adding}
          onChange={(value) => {
            setAdding(value);
            setError(undefined);
          }}
          onSave={() => void saveAdd()}
          onCancel={() => {
            setAdding(null);
            setError(undefined);
          }}
          error={error}
          placeholder={t('WorkStages.editor.newStagePlaceholder')}
          lead={
            <span
              className="tm-wk-stage__dot"
              style={{ background: groupColorVar(group) }}
              aria-hidden="true"
            />
          }
        />
      ) : canAddTo(set, group) ? (
        <button
          type="button"
          className="tm-stg-group__add"
          onClick={() => {
            setRenaming(null);
            setError(undefined);
            setAdding('');
          }}
        >
          <PlusIcon />
          {t('WorkStages.editor.addStage')}
        </button>
      ) : null}
    </section>
  );
}
