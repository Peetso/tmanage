'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { IconButton } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import type { StageSetView, StageView } from '../../../lib/api/work-stages';
import { VoiceControl } from '../../voice/VoiceControl';
import { useVoiceInput } from '../../voice/use-voice-language';
import { useA6T } from '../DueDatePicker';
import { initialsOf } from '../OwnerPickerDialog';
import { StageCapsule, useStageName } from '../stages/WorkStageControl';
import { GROUP_KEY, orderedStages, STAGE_GROUPS, stageColorVar } from '../stages/stage-model';
import { useDismiss } from '../use-dismiss';
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  DragIcon,
  PlusIcon,
} from '../work-icons';

/**
 * One property of New work (Figma `WV2-03` chip, `WV2-04` field): the same property, words and
 * editor as the work page's panel row, drawn as a chip in quick create and as a bordered field in
 * full create. The editor opens under it (`popover`), or `onAction` opens a picker dialog.
 */
export function CreateControl({
  label,
  value,
  empty = false,
  variant,
  labelledBy,
  popover,
  onAction,
  disabled = false,
  testId,
}: {
  label: string;
  value: ReactNode;
  empty?: boolean;
  variant: 'chip' | 'field';
  /** The row label's id, in full create; a chip names itself. */
  labelledBy?: string;
  popover?: (close: () => void) => ReactNode;
  onAction?: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const valueId = useId();
  const popoverId = useId();
  const close = (focus = true) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  useDismiss(open, box, (reason) => close(reason === 'escape'));
  return (
    <span ref={box} className="tm-nw-control" data-variant={variant} data-testid={testId}>
      <button
        ref={trigger}
        type="button"
        className={variant === 'chip' ? 'tm-nw-chip' : 'tm-nw-select'}
        data-empty={empty || undefined}
        aria-label={variant === 'chip' ? label : undefined}
        aria-labelledby={variant === 'field' && labelledBy ? `${labelledBy} ${valueId}` : undefined}
        aria-describedby={variant === 'chip' ? valueId : undefined}
        aria-haspopup="dialog"
        aria-expanded={popover ? open : undefined}
        aria-controls={open ? popoverId : undefined}
        disabled={disabled}
        onClick={() => (popover ? setOpen(!open) : onAction?.())}
      >
        <span id={valueId} className="tm-nw-select__value">
          {value}
        </span>
        <ChevronDownIcon />
      </button>
      {open && popover ? (
        <div
          id={popoverId}
          className="tm-wk-popover tm-nw-popover"
          role="dialog"
          aria-label={label}
        >
          {popover(() => close())}
        </div>
      ) : null}
    </span>
  );
}

/** A list of choices in a popover, the chosen one ticked (the panel's `tm-wk-choice`). */
export function ChoiceList<T extends string>({
  label,
  choices,
  isChosen,
  onChoose,
}: {
  label: string;
  choices: readonly { readonly id: T; readonly name: ReactNode }[];
  isChosen: (id: T) => boolean;
  onChoose: (id: T) => void;
}) {
  return (
    <ul className="tm-wk-choice" aria-label={label}>
      {choices.map((choice) => (
        <li key={choice.id}>
          <button
            type="button"
            className="tm-wk-menu__item"
            aria-pressed={isChosen(choice.id)}
            onClick={() => onChoose(choice.id)}
          >
            {choice.name}
            {isChosen(choice.id) ? <CheckIcon /> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Faces for the people chosen so far, then the words the row shows beside them. */
export function PeopleValue({
  ids,
  nameOf,
  text,
}: {
  ids: readonly string[];
  nameOf: (id: string) => string;
  text: string;
}) {
  return (
    <span className="tm-wk-faces">
      <span className="tm-wk-faces__stack" aria-hidden="true">
        {ids.slice(0, 3).map((id) => (
          <span key={id} className="tm-wk-face">
            {initialsOf(nameOf(id))}
          </span>
        ))}
      </span>
      <bdi>{text}</bdi>
    </span>
  );
}

/**
 * The stage menu of create (Figma `WV2-04b`): the set's stages in their four groups, then "Use
 * different stages for this work…", which lists the sets this work may use (W2c).
 */
export function StagePicker({
  set,
  stage,
  choices,
  projectSet,
  onStage,
  onSet,
}: {
  set: StageSetView | null;
  stage: StageView | null;
  choices: readonly StageSetView[];
  projectSet: StageSetView | null;
  onStage: (stage: StageView) => void;
  onSet: (set: StageSetView) => void;
}) {
  const t = useA6T();
  const name = useStageName();
  const [sets, showSets] = useState(false);
  const setName = (entry: StageSetView) =>
    entry.isBuiltIn ? t('WorkStages.builtInSet') : entry.name;
  if (!set) return <p className="tm-wk-section__empty">{t('WorkStages.noStage')}</p>;
  if (sets) {
    const list: StageSetView[] = [...choices];
    if (projectSet && !list.some((entry) => entry.id === projectSet.id)) list.unshift(projectSet);
    return (
      <div className="tm-nw-stagemenu">
        <p className="tm-wk-menu__title">{t('WorkStages.setsForThisWork')}</p>
        {list.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="tm-wk-menu__item tm-wk-setpicker__item"
            aria-pressed={entry.id === set.id}
            onClick={() => {
              onSet(entry);
              showSets(false);
            }}
          >
            <span className="tm-wk-setpicker__text">
              <span className="tm-wk-setpicker__name">
                <bdi>{setName(entry)}</bdi>
                {entry.id === projectSet?.id ? (
                  <span className="tm-wk-setpicker__note">{t('WorkStages.projectDefault')}</span>
                ) : entry.isDefault ? (
                  <span className="tm-wk-setpicker__note">{t('WorkStages.workspaceDefault')}</span>
                ) : null}
              </span>
              <span className="tm-wk-setpicker__dots" aria-hidden="true">
                {orderedStages(entry.stages).map((dot) => (
                  <span
                    key={dot.id}
                    className="tm-wk-stage__dot"
                    style={{ background: stageColorVar(dot) }}
                  />
                ))}
              </span>
            </span>
            {entry.id === set.id ? <CheckIcon /> : null}
          </button>
        ))}
      </div>
    );
  }
  const stages = orderedStages(set.stages);
  return (
    <div className="tm-nw-stagemenu">
      <p className="tm-wk-menu__title tm-nw-stagemenu__title">
        <bdi>{setName(set)}</bdi>
        <span className="tm-nw-stagemenu__kind">{t('WorkStages.stageSet')}</span>
      </p>
      {STAGE_GROUPS.map((group) => {
        const rows = stages.filter((entry) => entry.group === group);
        if (rows.length === 0) return null;
        return (
          <div key={group} role="group" aria-label={t(GROUP_KEY[group])}>
            <p className="tm-wk-menu__group">{t(GROUP_KEY[group])}</p>
            {rows.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="tm-wk-menu__item"
                aria-pressed={entry.id === stage?.id}
                onClick={() => onStage(entry)}
              >
                <StageCapsule stage={entry} name={name(entry, set)} />
                {entry.id === stage?.id ? <CheckIcon /> : null}
              </button>
            ))}
          </div>
        );
      })}
      <hr className="tm-wk-menu__rule" />
      <button type="button" className="tm-wk-menu__item" onClick={() => showSets(true)}>
        {t('WorkStages.useDifferent')}
      </button>
    </div>
  );
}

/**
 * Steps at create (Figma `WV2-04` Steps): the first steps of the work, in order, before it
 * exists. The same add row as the work page ("Add a step, press Enter" with the voice control);
 * a step can be moved with the keyboard buttons or taken off again.
 */
export function CreateSteps({
  api,
  organizationSlug,
  steps,
  onChange,
  labelledBy,
}: {
  api: ApiClient;
  organizationSlug: string;
  steps: readonly string[];
  onChange: (next: readonly string[]) => void;
  labelledBy: string;
}) {
  const t = useA6T();
  const [draft, setDraft] = useState('');
  const voice = useVoiceInput({ api, organizationSlug, value: draft, onChange: setDraft });
  const add = () => {
    const label = draft.trim();
    if (label === '') return;
    onChange([...steps, label.slice(0, 300)]);
    setDraft('');
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length) return;
    const next = [...steps];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved as string);
    onChange(next);
  };
  return (
    <div className="tm-nw-steps" role="group" aria-labelledby={labelledBy}>
      {steps.length > 0 ? (
        <ol className="tm-wk-steps__list">
          {steps.map((label, index) => (
            <li key={`${label}-${index}`} className="tm-wk-step">
              <span className="tm-wk-step__handle" aria-hidden="true">
                <DragIcon />
              </span>
              <span className="tm-wk-tick" aria-hidden="true" />
              <span className="tm-wk-step__name">
                <bdi>{label}</bdi>
              </span>
              <span className="tm-wk-step__spacer" />
              <span className="tm-nw-steps__actions">
                <IconButton
                  size="small"
                  label={t('WorkSteps.moveUp')}
                  icon={<ArrowUpIcon />}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                />
                <IconButton
                  size="small"
                  label={t('NewWork.removeStep', { step: label })}
                  icon={<CloseIcon />}
                  onClick={() => onChange(steps.filter((_, at) => at !== index))}
                />
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="tm-wk-addrow">
        <label className="tm-wk-field">
          <PlusIcon />
          <span className="tm-visually-hidden">{t('WorkSteps.addLabel')}</span>
          <input
            value={draft}
            maxLength={300}
            dir="auto"
            placeholder={t('WorkSteps.addPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter adds the step; it never submits the whole form.
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
          />
        </label>
        <VoiceControl input={voice} />
      </div>
    </div>
  );
}
