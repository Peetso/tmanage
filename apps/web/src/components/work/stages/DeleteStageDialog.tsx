'use client';

import { useId, useState } from 'react';
import { Button, IconButton, InlineAlert } from '@tmanage/ui';
import type { StageView } from '../../../lib/api/work-stages';
import { useA6T } from '../DueDatePicker';
import { CloseIcon } from '../work-icons';
import { StageDialogFrame } from './StageDialogFrame';
import { stageColorVar } from './stage-model';

/**
 * **Delete a stage** (Figma W9 `939:101154` EN desktop, `939:101335` AR phone sheet): asks where the stage's work
 * goes before anything is removed. The choices are the other stages of the same state (the only
 * ones the API takes, `deleteStage` `moveToStageId`); with none, the work goes to the first stage
 * of its group, and the dialog says so. Nothing is lost: works move, they are never deleted.
 *
 * A modal dialog (`StageDialogFrame`): Escape and Cancel
 * close it without a change.
 */
export function DeleteStageDialog({
  stage,
  stageName,
  targets,
  targetName,
  pending,
  failure,
  onConfirm,
  onClose,
}: {
  stage: StageView;
  stageName: string;
  targets: readonly StageView[];
  targetName: (stage: StageView) => string;
  pending: boolean;
  failure: string | undefined;
  onConfirm: (moveToStageId: string | undefined) => void;
  onClose: () => void;
}) {
  const t = useA6T();
  const titleId = useId();
  const selectId = useId();
  const [target, setTarget] = useState(targets[0]?.id ?? '');
  const chosen = targets.find((candidate) => candidate.id === target) ?? null;
  return (
    <StageDialogFrame labelledBy={titleId} kind="sheet" onClose={onClose}>
      <div className="tm-stg-dialog__head">
        <h2 id={titleId} className="tm-stg-dialog__title">
          {t('WorkStages.editor.deleteTitle', { stage: stageName })}
        </h2>
        <IconButton
          size="small"
          label={t('WorkStages.editor.close')}
          icon={<CloseIcon />}
          onClick={onClose}
        />
      </div>
      {targets.length > 0 ? (
        <>
          <label htmlFor={selectId} className="tm-stg-dialog__lede">
            {t('WorkStages.editor.deleteMoveTo')}
          </label>
          <span className="tm-stg-select">
            <span
              className="tm-wk-stage__dot"
              style={{ background: chosen ? stageColorVar(chosen) : stageColorVar(stage) }}
              aria-hidden="true"
            />
            <select
              id={selectId}
              className="tm-stg-select__control"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              {targets.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {targetName(candidate)}
                </option>
              ))}
            </select>
          </span>
        </>
      ) : (
        <p className="tm-stg-dialog__lede">{t('WorkStages.editor.deleteToGroup')}</p>
      )}
      {failure ? (
        <InlineAlert tone="danger" title={t('WorkStages.editor.notSaved')} live>
          {failure}
        </InlineAlert>
      ) : null}
      <div className="tm-wk-dialog__actions">
        <Button tone="text" size="large" onClick={onClose}>
          {t('NewWork.cancel')}
        </Button>
        <Button
          tone="destructive"
          size="large"
          loading={pending}
          onClick={() => onConfirm(chosen ? chosen.id : undefined)}
        >
          {targets.length > 0
            ? t('WorkStages.editor.moveAndDelete')
            : t('WorkStages.editor.delete')}
        </Button>
      </div>
    </StageDialogFrame>
  );
}
