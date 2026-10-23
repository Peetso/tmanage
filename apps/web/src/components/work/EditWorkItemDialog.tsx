'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, Checkbox, Field } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import type { UpdateWorkItemInput, WorkItemSummary } from '../../lib/api/work-items';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { dayToInstant } from '../../lib/work-item-presentation';
import { dayOf, DueDatePicker, formatChipDay, useA6T, WorkDialogFrame } from './DueDatePicker';
import { initialsOf, OwnerPickerDialog, useOwnerCandidates } from './OwnerPickerDialog';

export type WorkItemChanges = Omit<UpdateWorkItemInput, 'version'>;

export interface EditWorkItemDialogProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly item: WorkItemSummary;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  /** The client of the item's project, for the "can see this item" line. */
  readonly clientName?: string;
  /** "Move to another project" opens the dialog with the project control focused. */
  readonly focusProject?: boolean;
  readonly saving?: boolean;
  /** Field refusals from the API, by field name. */
  readonly fieldErrors?: ReadonlyMap<string, string>;
  /** Only the fields that changed. Nothing changed closes without a write. */
  readonly onSave: (changes: WorkItemChanges) => void;
  readonly onClose: () => void;
}

type Popover = 'owner' | 'due' | 'start' | null;

/**
 * **Edit work item (A6, Figma fq7-edit-work-item).**
 *
 * Title and description, then "Owner and dates": an Owner chip (the owner picker), Due and Start
 * chips (the date picker), a Project chip (moving the item; the API clears an owner who is not
 * on the new project) and "Visible to the client", which is the item's audience. Save sends only
 * what changed, with the version the screen read, as one PATCH.
 */
export function EditWorkItemDialog({
  api,
  organizationSlug,
  item,
  projects,
  clientName,
  focusProject = false,
  saving = false,
  fieldErrors,
  onSave,
  onClose,
}: EditWorkItemDialogProps) {
  const t = useA6T();
  const locale = useActiveLocale();
  const titleId = useId();
  const projectControl = useRef<HTMLSelectElement>(null);

  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? '');
  const [ownerUserId, setOwnerUserId] = useState<string | null>(item.ownerUserId);
  const [due, setDue] = useState(dayOf(item.dueAt));
  const [start, setStart] = useState(dayOf(item.startAt));
  const [projectId, setProjectId] = useState(item.projectId);
  const [visible, setVisible] = useState(item.audience !== 'internal');
  const [popover, setPopover] = useState<Popover>(null);
  const [titleError, setTitleError] = useState<string | undefined>(undefined);

  const owners = useOwnerCandidates(api, organizationSlug, projectId);
  const ownerName = owners.candidates.find((c) => c.userId === ownerUserId)?.displayName;
  const projectName = projects.find((project) => project.id === projectId)?.name ?? '';

  useEffect(() => {
    if (focusProject) projectControl.current?.focus();
  }, [focusProject]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === '') {
      setTitleError(t('EditWorkItem.titleRequired'));
      return;
    }
    const changes: { -readonly [K in keyof WorkItemChanges]: WorkItemChanges[K] } = {};
    if (trimmed !== item.title) changes.title = trimmed;
    const nextDescription = description.trim();
    if (nextDescription !== (item.description ?? '')) {
      changes.description = nextDescription === '' ? null : nextDescription;
    }
    if (projectId !== item.projectId) changes.projectId = projectId;
    if (ownerUserId !== item.ownerUserId) changes.ownerUserId = ownerUserId;
    if (due !== dayOf(item.dueAt)) changes.dueAt = dayToInstant(due);
    if (start !== dayOf(item.startAt)) changes.startAt = dayToInstant(start);
    const wasVisible = item.audience !== 'internal';
    if (visible !== wasVisible) changes.audience = visible ? 'client_visible' : 'internal';
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    onSave(changes);
  }

  const error = (field: string) => fieldErrors?.get(field);
  const titleProblem = titleError ?? error('title');
  const moveProblem = error('projectId') ?? error('ownerUserId');

  return (
    <WorkDialogFrame labelledBy={titleId} onClose={onClose}>
      <form className="tm-wk-dialog__form" noValidate onSubmit={submit}>
        <h2 id={titleId} className="tm-wk-dialog__title">
          {t('EditWorkItem.heading')}
        </h2>

        <Field
          label={t('EditWorkItem.titleLabel')}
          name="title"
          value={title}
          maxLength={300}
          required
          onChange={(event) => {
            setTitle(event.target.value);
            setTitleError(undefined);
          }}
          {...(titleProblem === undefined ? {} : { error: titleProblem })}
        />

        <div className="tm-field">
          <label className="tm-field__label" htmlFor={`${titleId}-description`}>
            {t('EditWorkItem.descriptionLabel')}
          </label>
          <textarea
            id={`${titleId}-description`}
            name="description"
            className="tm-field__control tm-wk-textarea"
            rows={2}
            maxLength={5000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          {error('description') ? (
            <span className="tm-field__error" role="alert">
              {error('description')}
            </span>
          ) : null}
        </div>

        <fieldset className="tm-wk-dialog__group">
          <legend className="tm-field__label">{t('EditWorkItem.ownerAndDates')}</legend>
          <div className="tm-wk-fact-chips">
            <button
              type="button"
              className="tm-wk-fact"
              aria-haspopup="dialog"
              onClick={() => setPopover('owner')}
            >
              {ownerUserId !== null ? (
                <span className="tm-wk-orb" aria-hidden="true">
                  {initialsOf(ownerName ?? '')}
                </span>
              ) : null}
              <span className="tm-wk-fact__text">
                <span className="tm-wk-fact__label">{t('WorkDetail.owner')}</span>
                <span className="tm-wk-fact__value">
                  {ownerUserId === null ? t('WorkDetail.nobody') : (ownerName ?? '…')}
                </span>
              </span>
              <span className="tm-wk-fact__caret" aria-hidden="true">
                ▾
              </span>
            </button>

            <div className="tm-wk-popover-anchor">
              <button
                type="button"
                className="tm-wk-fact"
                aria-haspopup="dialog"
                aria-expanded={popover === 'due'}
                onClick={() => setPopover(popover === 'due' ? null : 'due')}
              >
                <span className="tm-wk-fact__text">
                  <span className="tm-wk-fact__label">{t('WorkDetail.due')}</span>
                  <span className="tm-wk-fact__value">
                    {due === '' ? t('WorkDetail.noDate') : formatChipDay(due, locale)}
                  </span>
                </span>
                <span className="tm-wk-fact__caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {popover === 'due' ? (
                <DueDatePicker
                  heading={t('DueDatePicker.dueHeading')}
                  value={due}
                  {...(start === '' ? {} : { min: start })}
                  onSet={(day) => {
                    setDue(day ?? '');
                    setPopover(null);
                  }}
                  onClose={() => setPopover(null)}
                />
              ) : null}
            </div>
          </div>

          <div className="tm-wk-fact-chips">
            <div className="tm-wk-popover-anchor">
              <button
                type="button"
                className="tm-wk-fact"
                aria-haspopup="dialog"
                aria-expanded={popover === 'start'}
                onClick={() => setPopover(popover === 'start' ? null : 'start')}
              >
                <span className="tm-wk-fact__text">
                  <span className="tm-wk-fact__label">{t('WorkDetail.start')}</span>
                  <span className="tm-wk-fact__value">
                    {start === '' ? t('WorkDetail.noDate') : formatChipDay(start, locale)}
                  </span>
                </span>
                <span className="tm-wk-fact__caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {popover === 'start' ? (
                <DueDatePicker
                  heading={t('DueDatePicker.startHeading')}
                  value={start}
                  onSet={(day) => {
                    setStart(day ?? '');
                    setPopover(null);
                  }}
                  onClose={() => setPopover(null)}
                />
              ) : null}
            </div>

            <label className="tm-wk-fact" data-kind="select">
              <span className="tm-wk-fact__text">
                <span className="tm-wk-fact__label">{t('EditWorkItem.project')}</span>
                <select
                  ref={projectControl}
                  className="tm-wk-fact__select"
                  name="projectId"
                  value={projectId}
                  aria-label={t('EditWorkItem.project')}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </span>
              <span className="tm-wk-fact__caret" aria-hidden="true">
                ▾
              </span>
            </label>
          </div>
          {projectId !== item.projectId ? (
            <p className="tm-field__hint">{t('EditWorkItem.moveHint', { project: projectName })}</p>
          ) : null}
          {moveProblem === undefined ? null : (
            <span className="tm-field__error" role="alert">
              {moveProblem}
            </span>
          )}
        </fieldset>

        <Checkbox
          label={t('EditWorkItem.visible')}
          hint={t('EditWorkItem.visibleHint', { client: clientName ?? t('WorkA6.theClient') })}
          checked={visible}
          onChange={(event) => setVisible(event.target.checked)}
        />
        {error('audience') ? (
          <span className="tm-field__error" role="alert">
            {error('audience')}
          </span>
        ) : null}

        <div className="tm-wk-dialog__actions">
          <Button tone="outline" size="accessible" onClick={onClose}>
            {t('WorkA6.cancel')}
          </Button>
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={saving}
            loadingLabel={t('WorkA6.saving')}
          >
            {t('EditWorkItem.save')}
          </Button>
        </div>
      </form>

      {popover === 'owner' ? (
        <OwnerPickerDialog
          projectName={projectName}
          candidates={owners.candidates}
          loading={owners.loading}
          value={ownerUserId}
          onAssign={(userId) => {
            setOwnerUserId(userId);
            setPopover(null);
          }}
          onClose={() => setPopover(null)}
        />
      ) : null}
    </WorkDialogFrame>
  );
}
