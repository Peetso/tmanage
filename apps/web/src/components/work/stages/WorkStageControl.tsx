'use client';

import { useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WorkItemState } from '@tmanage/domain';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import {
  moveWorkToStage,
  setWorkStageSet,
  type StageSetView,
  type StageView,
} from '../../../lib/api/work-stages';
import { transitionWorkItem, type WorkItemSummary } from '../../../lib/api/work-items';
import { workItemKeys } from '../../../lib/query-keys';
import { useA6T } from '../DueDatePicker';
import { CheckIcon, ChevronDownIcon, PlusIcon } from '../work-icons';
import {
  autoFacts,
  BUILT_IN_NAME_KEY,
  GROUP_KEY,
  movesTo,
  orderedStages,
  STAGE_GROUPS,
  stageColorVar,
} from './stage-model';
import { useDismiss } from '../use-dismiss';
import { stageSetsKey, type WorkStages } from './use-work-stages';
import './stages.css';

/** A stage's name: its own, or the state label for the built-in stages. */
export function useStageName(): (stage: StageView, set: StageSetView | null) => string {
  const t = useA6T();
  return (stage, set) =>
    set?.isBuiltIn ? t(BUILT_IN_NAME_KEY[stage.stateKey] ?? 'WorkStages.stage') : stage.name;
}

/** Figma `Stage/Capsule` (`918:1959`): the coloured dot and the stage's name. */
export function StageCapsule({
  stage,
  name,
  muted = false,
}: {
  stage: Pick<StageView, 'colorKey' | 'group'>;
  name: string;
  muted?: boolean;
}) {
  return (
    <span className="tm-wk-stage" data-muted={muted || undefined}>
      <span
        className="tm-wk-stage__dot"
        style={{ background: stageColorVar(stage) }}
        aria-hidden="true"
      />
      <bdi>{name}</bdi>
    </span>
  );
}

/** The set's stages under the title, the current one strong (Figma `933:95423`). */
export function StageTrail({ stages }: { stages: WorkStages }) {
  const name = useStageName();
  const t = useA6T();
  if (!stages.set || !stages.stage) return null;
  const list = orderedStages(stages.set.stages);
  return (
    <ol className="tm-wk-trail" aria-label={t('WorkStages.trailLabel')}>
      {list.map((stage) => (
        <li key={stage.id} aria-current={stage.id === stages.stage?.id ? 'step' : undefined}>
          <bdi>{name(stage, stages.set)}</bdi>
        </li>
      ))}
    </ol>
  );
}

/**
 * The stage control beside the title and in the panel's Stage row: the capsule opens a menu of the
 * set's stages in their four groups; choosing one moves the work there (through the ordinary
 * state moves, so the supervisor rule and the audit trail hold). The menu's title names the set
 * (Fable must-fix 1) and its last line opens the set picker (must-fix 12, `934:96394`).
 */
export function WorkStageControl({
  api,
  organizationSlug,
  item,
  stages,
  onChanged,
  variant = 'header',
}: {
  api: ApiClient;
  organizationSlug: string;
  item: WorkItemSummary;
  stages: WorkStages;
  onChanged: (next: WorkItemSummary) => void;
  variant?: 'header' | 'panel';
}) {
  const t = useA6T();
  const name = useStageName();
  const [open, setOpen] = useState<'stages' | 'sets' | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const close = () => {
    setOpen(null);
    trigger.current?.focus();
  };
  useDismiss(open !== null, box, (reason) => (reason === 'escape' ? close() : setOpen(null)));

  const current = stages.stage;
  // Blocked and archived are not stages: the control says so in place of the stage the work
  // keeps, so nobody reads "Prototype" on a work that cannot move.
  const label =
    item.state === 'blocked'
      ? t('WorkListScreen.stateBlocked')
      : item.state === 'archived'
        ? t('WorkListScreen.stateArchived')
        : current
          ? name(current, stages.set)
          : t('WorkStages.noStage');

  return (
    <span
      ref={box}
      className="tm-wk-stagectl"
      data-variant={variant}
      data-testid={variant === 'header' ? 'work-item-status' : undefined}
    >
      <button
        ref={trigger}
        type="button"
        className="tm-wk-stagectl__trigger"
        aria-haspopup="dialog"
        aria-expanded={open !== null}
        aria-controls={open !== null ? menuId : undefined}
        aria-label={t('WorkStages.changeLabel', { stage: label })}
        title={stages.set ? t('WorkStages.setTooltip', { set: setName(stages.set, t) }) : undefined}
        disabled={stages.loading && !current}
        onClick={() => setOpen(open === null ? 'stages' : null)}
      >
        {current ? (
          <StageCapsule stage={current} name={label} />
        ) : (
          <span className="tm-wk-stage">{label}</span>
        )}
        {variant === 'header' ? <ChevronDownIcon /> : null}
      </button>
      {open === 'stages' && stages.set ? (
        <StageMenu
          id={menuId}
          api={api}
          organizationSlug={organizationSlug}
          item={item}
          set={stages.set}
          current={current}
          onChanged={(next) => {
            onChanged(next);
            close();
          }}
          onPickSet={() => setOpen('sets')}
        />
      ) : null}
      {open === 'sets' ? (
        <StageSetPicker
          id={menuId}
          api={api}
          organizationSlug={organizationSlug}
          item={item}
          stages={stages}
          onChanged={(next) => {
            onChanged(next);
            close();
          }}
        />
      ) : null}
    </span>
  );
}

function setName(set: StageSetView, t: (key: string) => string): string {
  return set.isBuiltIn ? t('WorkStages.builtInSet') : set.name;
}

const FACT_KEY: Readonly<Record<string, string>> = {
  reopenReason: 'WorkStages.fact.reopenReason',
  blockerResolution: 'WorkStages.fact.blockerResolution',
  ownerId: 'WorkStages.fact.ownerFirst',
};

function StageMenu({
  id,
  api,
  organizationSlug,
  item,
  set,
  current,
  onChanged,
  onPickSet,
}: {
  id: string;
  api: ApiClient;
  organizationSlug: string;
  item: WorkItemSummary;
  set: StageSetView;
  current: StageView | null;
  onChanged: (next: WorkItemSummary) => void;
  onPickSet: () => void;
}) {
  const t = useA6T();
  const name = useStageName();
  const describe = useDescribeApiError();
  const queries = useQueryClient();
  const titleId = useId();
  const [asking, setAsking] = useState<{ stage: StageView; facts: readonly string[] } | null>(null);
  const [answer, setAnswer] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const stages = orderedStages(set.stages);

  const move = useMutation({
    mutationFn: async ({ stage, extra }: { stage: StageView; extra: Record<string, string> }) => {
      const run = movesTo(item.state, stage.stateKey as WorkItemState);
      if (run === null) throw new Error(t('WorkStages.cannotMove'));
      let at = item;
      for (const to of run.before) {
        at = await transitionWorkItem(api, organizationSlug, item.id, { version: at.version, to });
      }
      const { facts } = autoFacts(run.needs, at.ownerUserId, new Date());
      return moveWorkToStage(api, organizationSlug, item.id, {
        stageId: stage.id,
        version: at.version,
        facts: { ...facts, ...extra },
      });
    },
    onSuccess: (next) => {
      void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
      onChanged(next);
    },
    onError: (error) => setFailure(describe(error)),
  });

  function choose(stage: StageView) {
    setFailure(undefined);
    if (stage.id === current?.id) return;
    const run = movesTo(item.state, stage.stateKey as WorkItemState);
    if (run === null) {
      setFailure(t('WorkStages.cannotMove'));
      return;
    }
    const { ask } = autoFacts(run.needs, item.ownerUserId, new Date());
    if (ask.includes('ownerId')) {
      setFailure(t('WorkStages.fact.ownerFirst'));
      return;
    }
    if (ask.length > 0) {
      setAsking({ stage, facts: ask });
      setAnswer('');
      return;
    }
    move.mutate({ stage, extra: {} });
  }

  return (
    <div id={id} className="tm-wk-menu tm-wk-stagemenu" role="dialog" aria-labelledby={titleId}>
      <p id={titleId} className="tm-wk-menu__title">
        <bdi>{setName(set, t)}</bdi> · {t('WorkStages.stageSet')}
      </p>
      {STAGE_GROUPS.map((group) => {
        const rows = stages.filter((stage) => stage.group === group);
        if (rows.length === 0) return null;
        return (
          <div key={group} role="group" aria-label={t(GROUP_KEY[group])}>
            <p className="tm-wk-menu__group">{t(GROUP_KEY[group])}</p>
            {rows.map((stage) => (
              <button
                key={stage.id}
                type="button"
                className="tm-wk-menu__item"
                aria-pressed={stage.id === current?.id}
                disabled={move.isPending}
                onClick={() => choose(stage)}
              >
                <StageCapsule stage={stage} name={name(stage, set)} />
                {stage.id === current?.id ? <CheckIcon /> : null}
              </button>
            ))}
          </div>
        );
      })}
      {asking ? (
        <form
          noValidate
          className="tm-wk-menu__ask"
          onSubmit={(event) => {
            event.preventDefault();
            if (answer.trim() === '') return;
            const extra: Record<string, string> = {};
            for (const fact of asking.facts) extra[fact] = answer.trim();
            move.mutate({ stage: asking.stage, extra });
          }}
        >
          <label className="tm-wk-menu__ask-label">
            {t(FACT_KEY[asking.facts[0] ?? ''] ?? 'WorkStages.fact.reopenReason')}
            <input
              className="tm-wk-input"
              value={answer}
              dir="auto"
              // The question appears because the person chose a stage: the answer box is next.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              onChange={(event) => setAnswer(event.target.value)}
            />
          </label>
          <Button type="submit" tone="ink" size="header" loading={move.isPending}>
            {t('WorkStages.move')}
          </Button>
        </form>
      ) : null}
      {failure ? (
        <InlineAlert tone="danger" title={t('WorkStages.moveFailed')} live>
          {failure}
        </InlineAlert>
      ) : null}
      <hr className="tm-wk-menu__rule" />
      <button type="button" className="tm-wk-menu__item" onClick={onPickSet}>
        {t('WorkStages.useDifferent')}
      </button>
    </div>
  );
}

/** Figma W2c (`934:96394`): the sets this work may use, with their stage dots. */
export function StageSetPicker({
  id,
  api,
  organizationSlug,
  item,
  stages,
  onChanged,
}: {
  id: string;
  api: ApiClient;
  organizationSlug: string;
  item: WorkItemSummary;
  stages: WorkStages;
  onChanged: (next: WorkItemSummary) => void;
}) {
  const t = useA6T();
  const describe = useDescribeApiError();
  const queries = useQueryClient();
  const titleId = useId();
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const save = useMutation({
    mutationFn: (stageSetId: string | null) =>
      setWorkStageSet(api, organizationSlug, item.id, { stageSetId, version: item.version }),
    onSuccess: (next) => {
      void queries.invalidateQueries({ queryKey: stageSetsKey(organizationSlug) });
      void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
      onChanged(next);
    },
    onError: (error) => setFailure(describe(error)),
  });
  const list: StageSetView[] = [...stages.choices];
  if (stages.projectSet && !list.some((set) => set.id === stages.projectSet?.id)) {
    list.unshift(stages.projectSet);
  }
  return (
    <div id={id} className="tm-wk-menu tm-wk-setpicker" role="dialog" aria-labelledby={titleId}>
      <p id={titleId} className="tm-wk-menu__title">
        {t('WorkStages.setsForThisWork')}
      </p>
      {list.map((set) => {
        const chosen = set.id === stages.set?.id;
        const note =
          set.id === stages.projectSet?.id
            ? t('WorkStages.projectDefault')
            : set.isDefault
              ? t('WorkStages.workspaceDefault')
              : null;
        return (
          <button
            key={set.id}
            type="button"
            className="tm-wk-menu__item tm-wk-setpicker__item"
            aria-pressed={chosen}
            disabled={save.isPending}
            onClick={() => {
              if (chosen) return;
              // Back to the project's set clears the work's own set.
              save.mutate(set.id === stages.projectSet?.id ? null : set.id);
            }}
          >
            <span className="tm-wk-setpicker__text">
              <span className="tm-wk-setpicker__name">
                <bdi>{setName(set, t)}</bdi>
                {note ? <span className="tm-wk-setpicker__note">{note}</span> : null}
              </span>
              <span className="tm-wk-setpicker__dots" aria-hidden="true">
                {orderedStages(set.stages).map((stage) => (
                  <span
                    key={stage.id}
                    className="tm-wk-stage__dot"
                    style={{ background: stageColorVar(stage) }}
                  />
                ))}
              </span>
            </span>
            {chosen ? <CheckIcon /> : null}
          </button>
        );
      })}
      {failure ? (
        <InlineAlert tone="danger" title={t('WorkStages.moveFailed')} live>
          {failure}
        </InlineAlert>
      ) : null}
      <hr className="tm-wk-menu__rule" />
      <Link className="tm-wk-menu__item" href={`/${organizationSlug}/settings/stages?new=1`}>
        <PlusIcon />
        {t('WorkStages.newSet')}
      </Link>
    </div>
  );
}
