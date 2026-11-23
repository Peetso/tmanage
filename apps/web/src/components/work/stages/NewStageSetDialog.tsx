'use client';

import { useId, useState, type FormEvent } from 'react';
import { Button, IconButton, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { createStageSet, type StageSetView } from '../../../lib/api/work-stages';
import { useA6T } from '../DueDatePicker';
import { CloseIcon } from '../work-icons';
import {
  checkSetName,
  NAME_ERROR_KEY,
  SET_STARTS,
  startStages,
  type SetStart,
} from './stage-editor-model';
import { StageDialogFrame } from './StageDialogFrame';
import { StageNameField } from './StageNameField';
import { useStageSetWrites } from './use-stage-editor';

const START_KEY: Readonly<Record<SetStart, string>> = {
  simple: 'WorkStages.editor.startSimple',
  designThinking: 'WorkStages.editor.startDesignThinking',
  empty: 'WorkStages.editor.startEmpty',
};

/**
 * **New stage set** (Figma W8 `937:100415` EN, `937:100464` AR; a 560 dialog on desktop, a whole
 * page on phone with Create in the header, 40 high). The name can be typed or dictated in any
 * language; the set starts from Simple, Design thinking (Empathize, Define, Ideate, Prototype,
 * Test, Done) or one stage in each group, each named in the reader's language and renamable after.
 *
 * Where the set belongs is the caller's: with `projectId` it is that project's own set, and the
 * API points the project at it at once; without, it is a workspace set that projects and single
 * works can choose. A modal dialog (WAI-ARIA APG "Dialog (Modal)").
 */
export function NewStageSetDialog({
  api,
  organizationSlug,
  projectId,
  sets,
  onCreated,
  onClose,
}: {
  api: ApiClient;
  organizationSlug: string;
  projectId?: string;
  /** The sets already there, so a taken name is caught before the request. */
  sets: readonly StageSetView[];
  onCreated: (set: StageSetView) => void;
  onClose: () => void;
}) {
  const t = useA6T();
  const titleId = useId();
  const nameId = useId();
  const writes = useStageSetWrites(organizationSlug);
  const [name, setName] = useState('');
  const [start, setStart] = useState<SetStart>('designThinking');
  const [nameError, setNameError] = useState<string | undefined>(undefined);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const checked = checkSetName(name, sets);
    if ('error' in checked) {
      setNameError(t(NAME_ERROR_KEY[checked.error]));
      return;
    }
    setNameError(undefined);
    const created = await writes.run(() =>
      createStageSet(api, organizationSlug, {
        name: checked.name,
        stages: startStages(start, t),
        ...(projectId ? { projectId } : {}),
      }),
    );
    if (created) onCreated(created);
  }

  return (
    <StageDialogFrame labelledBy={titleId} kind="page" onClose={onClose}>
      <form className="tm-stg-new" noValidate onSubmit={(event) => void submit(event)}>
        <div className="tm-stg-dialog__head">
          <IconButton
            size="small"
            className="tm-stg-new__close"
            label={t('WorkStages.editor.close')}
            icon={<CloseIcon />}
            onClick={onClose}
          />
          <h2 id={titleId} className="tm-stg-dialog__title">
            {t('WorkStages.newSet')}
          </h2>
          <Button
            type="submit"
            tone="lime"
            size="large"
            className="tm-stg-new__head-create"
            loading={writes.pending}
          >
            {t('NewWork.create')}
          </Button>
        </div>
        <div className="tm-stg-new__field">
          <label htmlFor={nameId} className="tm-stg-new__label">
            {t('WorkStages.editor.name')}
          </label>
          <StageNameField
            id={nameId}
            api={api}
            organizationSlug={organizationSlug}
            label={t('WorkStages.editor.setNameLabel')}
            value={name}
            onChange={(next) => {
              setName(next);
              if (nameError) setNameError(undefined);
            }}
            error={nameError}
            layout="inline"
            placeholder={t('WorkStages.editor.setNamePlaceholder')}
          />
        </div>
        <fieldset className="tm-stg-new__starts">
          <legend className="tm-stg-new__overline">{t('WorkStages.editor.startFrom')}</legend>
          {SET_STARTS.map((option) => (
            <label
              key={option}
              className="tm-stg-start"
              data-checked={option === start || undefined}
            >
              <input
                type="radio"
                name={`${titleId}-start`}
                value={option}
                checked={option === start}
                onChange={() => setStart(option)}
              />
              <span className="tm-stg-start__name">{t(START_KEY[option])}</span>
              <span className="tm-stg-start__line">
                {option === 'empty'
                  ? t('WorkStages.editor.startEmptyLine')
                  : startStages(option, t)
                      .map((stage) => stage.name)
                      .join(' · ')}
              </span>
            </label>
          ))}
        </fieldset>
        {writes.failure ? (
          <InlineAlert tone="danger" title={t('WorkStages.editor.notCreated')} live>
            {writes.failure}
          </InlineAlert>
        ) : null}
        <div className="tm-wk-dialog__actions tm-stg-new__foot">
          <Button type="button" tone="text" size="large" onClick={onClose}>
            {t('NewWork.cancel')}
          </Button>
          <Button type="submit" tone="lime" size="large" loading={writes.pending}>
            {t('NewWork.create')}
          </Button>
        </div>
      </form>
    </StageDialogFrame>
  );
}
