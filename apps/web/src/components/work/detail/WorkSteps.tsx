'use client';

import { useId, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconButton, InlineAlert, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import {
  addChecklistItem,
  convertChecklistItem,
  deleteChecklistItem,
  listChecklist,
  reorderChecklist,
  updateChecklistItem,
  type WorkChecklistItem,
} from '../../../lib/api/work-items';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { tickChecklistOrQueue } from '../../../lib/offline/write-or-queue';
import { usePendingWrites } from '../../../lib/offline/use-offline';
import { workItemKeys } from '../../../lib/query-keys';
import { PendingBadge } from '../../pwa/PendingBadge';
import { VoiceControl } from '../../voice/VoiceControl';
import { useVoiceInput } from '../../voice/use-voice-language';
import { formatShortDay, useA6T } from '../DueDatePicker';
import { initialsOf, type OwnerCandidate } from '../OwnerPickerDialog';
import { useDismiss } from '../use-dismiss';
import { CheckIcon, DragIcon, MoreIcon, PlusIcon } from '../work-icons';

/** Move one id within an order (drag or the keyboard "Move up/down"). */
export function movedOrder(ids: readonly string[], id: string, toIndex: number): readonly string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const target = Math.max(0, Math.min(ids.length - 1, toIndex));
  const next = ids.filter((candidate) => candidate !== id);
  next.splice(target, 0, id);
  return next;
}

export function stepsKey(organizationSlug: string, workItemId: string) {
  return ['work-item-checklist', organizationSlug, workItemId] as const;
}

/**
 * The work's steps (Work area v2, Figma `Step/Row` `918:1958`; the to-do list that replaced the
 * old checklist and subtasks, API W-API-3): add (typed or dictated), tick, reorder (drag, or Move
 * up / Move down from the row's menu for keyboard users), give a step a person and a day, turn a
 * step into a work of its own, and delete it. Header "2 of 5" with a 4 px progress line. A tick
 * made offline is queued and shows the pending badge until it is sent (53-16).
 */
export function WorkSteps({
  api,
  organizationSlug,
  workItemId,
  people,
  onOpenItem,
  readOnly = false,
}: {
  api: ApiClient;
  organizationSlug: string;
  workItemId: string;
  people: readonly OwnerCandidate[];
  onOpenItem: (workItemId: string) => void;
  readOnly?: boolean;
}) {
  const t = useA6T();
  const describe = useDescribeApiError();
  const queries = useQueryClient();
  const headingId = useId();
  const key = stepsKey(organizationSlug, workItemId);
  const [draft, setDraft] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState<string | null>(null);
  const voice = useVoiceInput({ api, organizationSlug, value: draft, onChange: setDraft });

  const steps = useQuery({
    queryKey: key,
    queryFn: () => listChecklist(api, organizationSlug, workItemId),
  });
  const refresh = () => void queries.invalidateQueries({ queryKey: key });
  const fail = (error: unknown) => setFailure(describe(error));

  const add = useMutation({
    mutationFn: (label: string) => addChecklistItem(api, organizationSlug, workItemId, { label }),
    onSuccess: () => {
      setDraft('');
      setFailure(undefined);
      refresh();
    },
    onError: fail,
  });
  const tick = useMutation({
    mutationFn: (item: WorkChecklistItem) =>
      tickChecklistOrQueue(api, organizationSlug, workItemId, item, !item.done),
    onSuccess: () => {
      setFailure(undefined);
      refresh();
    },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof updateChecklistItem>[4] }) =>
      updateChecklistItem(api, organizationSlug, workItemId, id, input),
    onSuccess: refresh,
    onError: fail,
  });
  const reorder = useMutation({
    mutationFn: (ids: readonly string[]) =>
      reorderChecklist(api, organizationSlug, workItemId, ids),
    onSuccess: (items) => queries.setQueryData(key, items),
    onError: (error) => {
      fail(error);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteChecklistItem(api, organizationSlug, workItemId, id),
    onSuccess: refresh,
    onError: fail,
  });
  const convert = useMutation({
    mutationFn: (id: string) => convertChecklistItem(api, organizationSlug, workItemId, id),
    onSuccess: (work) => {
      refresh();
      void queries.invalidateQueries({ queryKey: workItemKeys.all(organizationSlug) });
      onOpenItem(work.id);
    },
    onError: fail,
  });

  const pending = usePendingWrites(organizationSlug, workItemId, 'checklist');
  const queued = new Map(pending.map((write) => [write.payload.itemId, write]));
  const items = (steps.data ?? []).map((item) => {
    const write = queued.get(item.id);
    return write ? { ...item, done: write.payload.done } : item;
  });
  const ids = items.map((item) => item.id);
  const doneCount = items.filter((item) => item.done).length;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = draft.trim();
    if (label !== '') add.mutate(label.slice(0, 300));
  }

  function drop(event: DragEvent<HTMLLIElement>, overId: string) {
    event.preventDefault();
    if (dragging === null || dragging === overId) return;
    const next = movedOrder(ids, dragging, ids.indexOf(overId));
    queries.setQueryData(
      key,
      next.map((id) => items.find((item) => item.id === id) as WorkChecklistItem),
    );
    reorder.mutate(next);
    setDragging(null);
  }

  return (
    <section className="tm-wk-section tm-wk-steps" aria-labelledby={headingId}>
      <div className="tm-wk-section__head">
        <h2 id={headingId} className="tm-wk-section__title">
          {t('WorkSteps.heading')}
        </h2>
        {items.length > 0 ? (
          <>
            <span className="tm-wk-section__meta">
              {t('WorkSteps.progress', { done: doneCount, total: items.length })}
            </span>
            <progress
              className="tm-wk-steps__bar"
              max={items.length}
              value={doneCount}
              aria-label={t('WorkSteps.progress', { done: doneCount, total: items.length })}
            />
          </>
        ) : null}
      </div>

      {steps.isPending ? <Skeleton height="var(--app-panel-row)" /> : null}
      {steps.isError ? (
        <InlineAlert tone="danger" title={t('WorkSteps.loadError')} live>
          {describe(steps.error)}
        </InlineAlert>
      ) : null}

      {items.length > 0 ? (
        <ol className="tm-wk-steps__list" aria-label={t('WorkSteps.heading')}>
          {items.map((item, index) => (
            <li
              key={item.id}
              className="tm-wk-step"
              data-done={item.done || undefined}
              data-dragging={dragging === item.id || undefined}
              onDragOver={(event) => {
                if (dragging !== null) event.preventDefault();
              }}
              onDrop={(event) => drop(event, item.id)}
            >
              {readOnly ? null : (
                <span
                  className="tm-wk-step__handle"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', item.id);
                    setDragging(item.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                  title={t('WorkSteps.dragHint')}
                  aria-hidden="true"
                >
                  <DragIcon />
                </span>
              )}
              <button
                type="button"
                className="tm-wk-tick"
                role="checkbox"
                aria-checked={item.done}
                aria-label={item.label}
                disabled={readOnly || tick.isPending}
                onClick={() => tick.mutate(item)}
              >
                {item.done ? <CheckIcon /> : null}
              </button>
              <StepName
                item={item}
                readOnly={readOnly}
                onRename={(label) => update.mutate({ id: item.id, input: { label } })}
              />
              <StepMeta item={item} people={people} />
              {queued.has(item.id) ? (
                <PendingBadge conflict={queued.get(item.id)?.status === 'conflict'} />
              ) : null}
              <span className="tm-wk-step__spacer" />
              {readOnly ? null : (
                <StepMenu
                  item={item}
                  people={people}
                  first={index === 0}
                  last={index === items.length - 1}
                  onAssign={(assigneeUserId) =>
                    update.mutate({ id: item.id, input: { assigneeUserId } })
                  }
                  onDate={(dueOn) => update.mutate({ id: item.id, input: { dueOn } })}
                  onMove={(delta) => reorder.mutate(movedOrder(ids, item.id, index + delta))}
                  onConvert={() => convert.mutate(item.id)}
                  onDelete={() => remove.mutate(item.id)}
                />
              )}
            </li>
          ))}
        </ol>
      ) : steps.isSuccess ? (
        <p className="tm-wk-section__empty">{t('WorkSteps.empty')}</p>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title={t('WorkSteps.saveError')} live>
          {failure}
        </InlineAlert>
      ) : null}

      {readOnly ? null : (
        <form className="tm-wk-addrow" noValidate onSubmit={submit}>
          <label className="tm-wk-field">
            <PlusIcon />
            <span className="tm-visually-hidden">{t('WorkSteps.addLabel')}</span>
            <input
              value={draft}
              maxLength={300}
              dir="auto"
              placeholder={t('WorkSteps.addPlaceholder')}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <VoiceControl input={voice} />
        </form>
      )}
    </section>
  );
}

/** The step's name; a double-click or Enter on it renames it in place. */
function StepName({
  item,
  readOnly,
  onRename,
}: {
  item: WorkChecklistItem;
  readOnly: boolean;
  onRename: (label: string) => void;
}) {
  const t = useA6T();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(item.label);
  if (editing) {
    return (
      <input
        className="tm-wk-step__edit"
        value={value}
        dir="auto"
        aria-label={t('WorkSteps.rename')}
        maxLength={300}
        // Opened by the person's own rename action, so focus goes to the box they asked for.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          setEditing(false);
          if (value.trim() !== '' && value.trim() !== item.label) onRename(value.trim());
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setValue(item.label);
            setEditing(false);
          }
        }}
      />
    );
  }
  return readOnly ? (
    <span className="tm-wk-step__name">{item.label}</span>
  ) : (
    <button
      type="button"
      className="tm-wk-step__name"
      title={t('WorkSteps.renameHint')}
      onClick={() => {
        setValue(item.label);
        setEditing(true);
      }}
    >
      <bdi>{item.label}</bdi>
    </button>
  );
}

/** "SA · 24 Nov": who does the step and its day, straight after the name (nice-to-have 1). */
function StepMeta({
  item,
  people,
}: {
  item: WorkChecklistItem;
  people: readonly OwnerCandidate[];
}) {
  const locale = useActiveLocale();
  const person = people.find((candidate) => candidate.userId === item.assigneeUserId);
  const parts = [
    person ? initialsOf(person.displayName) : null,
    item.dueOn ? formatShortDay(item.dueOn, locale) : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  // Each part isolated, so Latin initials and a localized day keep their own order in Arabic.
  return (
    <span className="tm-wk-step__meta" title={person?.displayName}>
      {parts.map((part, index) => (
        <span key={part}>
          {index > 0 ? ' · ' : null}
          <bdi>{part}</bdi>
        </span>
      ))}
    </span>
  );
}

function StepMenu({
  item,
  people,
  first,
  last,
  onAssign,
  onDate,
  onMove,
  onConvert,
  onDelete,
}: {
  item: WorkChecklistItem;
  people: readonly OwnerCandidate[];
  first: boolean;
  last: boolean;
  onAssign: (userId: string | null) => void;
  onDate: (day: string | null) => void;
  onMove: (delta: number) => void;
  onConvert: () => void;
  onDelete: () => void;
}) {
  const t = useA6T();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const box = useRef<HTMLSpanElement>(null);
  useDismiss(open, box, (reason) => {
    setOpen(false);
    if (reason === 'escape') box.current?.querySelector('button')?.focus();
  });
  const done = (action: () => void) => () => {
    action();
    setOpen(false);
  };
  return (
    <span
      ref={box}
      className="tm-wk-step__more"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <IconButton
        size="small"
        label={t('WorkSteps.menuLabel', { step: item.label })}
        icon={<MoreIcon />}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
      />
      {open ? (
        <div id={menuId} className="tm-wk-menu tm-wk-step__menu" role="group">
          <label className="tm-wk-menu__field">
            <span>{t('WorkSteps.who')}</span>
            <select
              value={item.assigneeUserId ?? ''}
              onChange={(event) => onAssign(event.target.value === '' ? null : event.target.value)}
            >
              <option value="">{t('WorkSteps.nobody')}</option>
              {people.map((person) => (
                <option key={person.userId} value={person.userId}>
                  {person.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="tm-wk-menu__field">
            <span>{t('WorkSteps.day')}</span>
            <input
              type="date"
              value={item.dueOn ?? ''}
              onChange={(event) => onDate(event.target.value === '' ? null : event.target.value)}
            />
          </label>
          <hr className="tm-wk-menu__rule" />
          <button
            type="button"
            className="tm-wk-menu__item"
            disabled={first}
            onClick={done(() => onMove(-1))}
          >
            {t('WorkSteps.moveUp')}
          </button>
          <button
            type="button"
            className="tm-wk-menu__item"
            disabled={last}
            onClick={done(() => onMove(1))}
          >
            {t('WorkSteps.moveDown')}
          </button>
          <button type="button" className="tm-wk-menu__item" onClick={done(onConvert)}>
            {t('WorkSteps.convert')}
          </button>
          <button
            type="button"
            className="tm-wk-menu__item"
            data-tone="danger"
            onClick={done(onDelete)}
          >
            {t('WorkSteps.delete')}
          </button>
        </div>
      ) : null}
    </span>
  );
}
