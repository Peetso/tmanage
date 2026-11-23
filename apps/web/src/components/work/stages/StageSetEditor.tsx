'use client';

import { useId, useState, type ReactNode } from 'react';
import { Button, IconButton, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import {
  createStageSet,
  deleteStage,
  deleteStageSet,
  updateStageSet,
  type StageSetView,
  type StageView,
} from '../../../lib/api/work-stages';
import { useA6T } from '../DueDatePicker';
import { PencilIcon } from '../work-icons';
import { DeleteStageDialog } from './DeleteStageDialog';
import { StageDialogFrame } from './StageDialogFrame';
import { StageGroupCard } from './StageGroupCard';
import { StageMoreMenu } from './StageMoreMenu';
import { StageNameField } from './StageNameField';
import { checkSetName, copyOf, moveTargets, NAME_ERROR_KEY } from './stage-editor-model';
import { STAGE_GROUPS } from './stage-model';
import { useStageSetWrites } from './use-stage-editor';
import { useStageName } from './WorkStageControl';

/** The line under a set's name: what uses it (the API sends no usage counts yet). */
function noteKey(set: StageSetView): string {
  if (set.isBuiltIn) return 'WorkStages.editor.noteBuiltIn';
  if (set.isDefault) return 'WorkStages.editor.noteDefault';
  if (set.projectId !== null) return 'WorkStages.editor.noteProject';
  return 'WorkStages.editor.noteChoice';
}

/**
 * **One stage set in the editor** (Figma W7 `937:99028` EN, `937:99338` AR, phone `937:99538`):
 * its name (renamed in place, typed or dictated), Duplicate and ⋯ (make it the workspace default,
 * delete the set), then the four fixed groups with their stages. The built-in stages are shown
 * read-only: Duplicate makes a set with the same stages that can be changed.
 */
export function StageSetEditor({
  api,
  organizationSlug,
  set,
  sets,
  back,
  onSelect,
  onDeleted,
}: {
  api: ApiClient;
  organizationSlug: string;
  set: StageSetView;
  sets: readonly StageSetView[];
  /** The phone's "‹ Stages" back to the list. */
  back?: ReactNode;
  onSelect: (setId: string) => void;
  onDeleted: () => void;
}) {
  const t = useA6T();
  const builtInName = useStageName();
  const titleId = useId();
  const writes = useStageSetWrites(organizationSlug);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [deleting, setDeleting] = useState<StageView | null>(null);
  const [deletingSet, setDeletingSet] = useState(false);
  const editable = !set.isBuiltIn;
  const setName = set.isBuiltIn ? t('WorkStages.builtInSet') : set.name;
  const stageName = (stage: StageView) => builtInName(stage, set);

  async function saveName() {
    if (renaming === null) return;
    if (renaming.trim() === set.name) {
      setRenaming(null);
      return;
    }
    const checked = checkSetName(renaming, sets, set.id);
    if ('error' in checked) {
      setNameError(t(NAME_ERROR_KEY[checked.error]));
      return;
    }
    const saved = await writes.run(() =>
      updateStageSet(api, organizationSlug, set.id, { version: set.version, name: checked.name }),
    );
    if (saved !== null) {
      setRenaming(null);
      setNameError(undefined);
    }
  }

  async function duplicate() {
    const copy = copyOf(
      set,
      sets.map((entry) => entry.name),
      t('WorkStages.editor.copyName', { name: setName }),
      stageName,
    );
    const created = await writes.run(() => createStageSet(api, organizationSlug, copy));
    if (created) onSelect(created.id);
  }

  return (
    <section className="tm-stg-editor" aria-labelledby={titleId}>
      {back}
      <div className="tm-stg-editor__head">
        {renaming !== null ? (
          <div className="tm-stg-editor__rename">
            <StageNameField
              api={api}
              organizationSlug={organizationSlug}
              label={t('WorkStages.editor.setNameLabel')}
              value={renaming}
              onChange={(value) => {
                setRenaming(value);
                setNameError(undefined);
              }}
              onSave={() => void saveName()}
              onCancel={() => {
                setRenaming(null);
                setNameError(undefined);
              }}
              error={nameError}
              layout="inline"
            />
            <h2 id={titleId} className="tm-visually-hidden">
              {setName}
            </h2>
          </div>
        ) : (
          <h2 id={titleId} className="tm-stg-editor__title">
            <bdi>{setName}</bdi>
            {editable ? (
              <IconButton
                size="small"
                label={t('WorkStages.editor.renameSet', { set: setName })}
                icon={<PencilIcon />}
                onClick={() => setRenaming(set.name)}
              />
            ) : null}
          </h2>
        )}
        <span className="tm-stg-editor__actions">
          <Button
            tone="text"
            size="header"
            loading={writes.pending}
            onClick={() => void duplicate()}
          >
            {t('WorkStages.editor.duplicate')}
          </Button>
          {editable ? (
            <StageMoreMenu
              label={t('WorkStages.editor.moreForSet', { set: setName })}
              entries={[
                ...(set.projectId === null && !set.isDefault
                  ? [
                      {
                        id: 'default',
                        label: t('WorkStages.editor.makeDefault'),
                        onSelect: () =>
                          void writes.run(() =>
                            updateStageSet(api, organizationSlug, set.id, {
                              version: set.version,
                              isDefault: true,
                            }),
                          ),
                      },
                    ]
                  : []),
                {
                  id: 'delete',
                  label: t('WorkStages.editor.deleteSet'),
                  danger: true,
                  onSelect: () => setDeletingSet(true),
                },
              ]}
            />
          ) : null}
        </span>
      </div>
      <p className="tm-stg-editor__note">{t(noteKey(set))}</p>
      {writes.failure && !deleting && !deletingSet ? (
        <InlineAlert tone="danger" title={t('WorkStages.editor.notSaved')} live>
          {writes.failure}
        </InlineAlert>
      ) : null}
      <div className="tm-stg-editor__groups">
        {STAGE_GROUPS.map((group) => (
          <StageGroupCard
            key={group}
            api={api}
            organizationSlug={organizationSlug}
            set={set}
            group={group}
            editable={editable}
            writes={writes}
            stageName={stageName}
            onDelete={(stage) => {
              writes.clearFailure();
              setDeleting(stage);
            }}
          />
        ))}
      </div>
      {deleting ? (
        <DeleteStageDialog
          stage={deleting}
          stageName={stageName(deleting)}
          targets={moveTargets(set, deleting)}
          targetName={stageName}
          pending={writes.pending}
          failure={writes.failure}
          onClose={() => {
            writes.clearFailure();
            setDeleting(null);
          }}
          onConfirm={async (moveTo) => {
            const done = await writes.run(() =>
              deleteStage(api, organizationSlug, set.id, deleting.id, moveTo),
            );
            if (done !== null) setDeleting(null);
          }}
        />
      ) : null}
      {deletingSet ? (
        <DeleteSetDialog
          setName={setName}
          pending={writes.pending}
          failure={writes.failure}
          onClose={() => {
            writes.clearFailure();
            setDeletingSet(false);
          }}
          onConfirm={async () => {
            const done = await writes.run(() => deleteStageSet(api, organizationSlug, set.id));
            if (done !== null) {
              setDeletingSet(false);
              onDeleted();
            }
          }}
        />
      ) : null}
    </section>
  );
}

/** Delete a whole set: the API refuses while projects or works use it, and the dialog says why. */
function DeleteSetDialog({
  setName,
  pending,
  failure,
  onConfirm,
  onClose,
}: {
  setName: string;
  pending: boolean;
  failure: string | undefined;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useA6T();
  const titleId = useId();
  return (
    <StageDialogFrame labelledBy={titleId} kind="sheet" onClose={onClose}>
      <div className="tm-stg-dialog__head">
        <h2 id={titleId} className="tm-stg-dialog__title">
          {t('WorkStages.editor.deleteSetTitle', { set: setName })}
        </h2>
      </div>
      <p className="tm-stg-dialog__lede">{t('WorkStages.editor.deleteSetBody')}</p>
      {failure ? (
        <InlineAlert tone="danger" title={t('WorkStages.editor.notSaved')} live>
          {failure}
        </InlineAlert>
      ) : null}
      <div className="tm-wk-dialog__actions">
        <Button tone="text" size="large" onClick={onClose}>
          {t('NewWork.cancel')}
        </Button>
        <Button tone="destructive" size="large" loading={pending} onClick={onConfirm}>
          {t('WorkStages.editor.delete')}
        </Button>
      </div>
    </StageDialogFrame>
  );
}
