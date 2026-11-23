'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, IconButton, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { OFFLINE_LINES, useDescribeApiError } from '../../../lib/api/describe-error';
import { defineWorkLabel } from '../../../lib/api/work-labels';
import { WORK_ITEM_RECURRENCE_FREQS } from '../../../lib/api/work-item-recurrence';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { parseQuickDate } from '../../../lib/quick-date';
import { CaptureAttachmentPicker, CaptureLabelPicker } from '../../screens/CaptureExtras';
import { DriveAttachPicker } from '../../storage/DriveAttachPicker';
import { NoStorageAttach, useAttachStorageState } from '../../storage/NoStorageAttach';
import { OneDriveAttachPicker } from '../../storage/OneDriveAttachPicker';
import { UploadProgressItem } from '../../storage/UploadProgress';
import { VoiceControl } from '../../voice/VoiceControl';
import { useVoiceInput } from '../../voice/use-voice-language';
import { DueDatePicker, formatChipDay, useA6T } from '../DueDatePicker';
import { PeoplePickerDialog } from '../WorkPeopleBlock';
import { StageCapsule, useStageName } from '../stages/WorkStageControl';
import {
  CalendarIcon,
  ChevronDownIcon,
  CloseIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
} from '../work-icons';
import {
  ChoiceList,
  CreateControl,
  CreateSteps,
  PeopleValue,
  StagePicker,
} from './NewWorkControls';
import type { NewWorkState } from './use-new-work';
// The steps, popovers and pickers are the work page's own parts, drawn by its sheet.
import '../detail/work-detail.css';
import './new-work.css';

export type NewWorkMode = 'quick' | 'full';

type PeopleRow = 'doers' | 'supervisors' | 'watchers';

export interface NewWorkFormProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly work: NewWorkState;
  readonly mode: NewWorkMode;
  /** `dialog` (desktop dialog, phone sheet / full page) or `page` (the `/capture` route). */
  readonly layout: 'dialog' | 'page';
  readonly titleId: string;
  /** Quick → full ("All fields"). */
  readonly onAllFields?: () => void;
  readonly onClose?: () => void;
  readonly now?: Date;
}

/**
 * **New work** (Work area v2, W-WEB-3; Figma `WV2-03` quick `934:97365`, `WV2-04` full
 * `935:97514`, phone `934:98215` sheet and `935:98783` page). One form, two sizes:
 *
 * - **Quick:** the name with voice naming in any language, then six chips in the work page's
 *   order and words — Project, Stage, Doers, Supervisor, Due, Client.
 * - **Full:** the same six as rows, then Steps and Description, then More (Start, Labels, Repeats,
 *   Watchers, Files, Reminder), the order of the work page's properties panel.
 *
 * Every property opens the same editor the panel uses (stage menu and set picker, people picker,
 * date picker, client list), so a work is made with exactly the facts it is later edited with.
 */
export function NewWorkForm({
  api,
  organizationSlug,
  work,
  mode,
  layout,
  titleId,
  onAllFields,
  onClose,
  now,
}: NewWorkFormProps) {
  const t = useA6T();
  const locale = useActiveLocale();
  const describe = useDescribeApiError(OFFLINE_LINES);
  const stageName = useStageName();
  const queries = useQueryClient();
  const voice = useVoiceInput({
    api,
    organizationSlug,
    value: work.title,
    onChange: (next) => work.setTitle(next.slice(0, 300)),
  });
  const [picking, setPicking] = useState<PeopleRow | null>(null);
  const [more, setMore] = useState(layout === 'page');
  const attachState = useAttachStorageState(organizationSlug, api);
  const noStorage = attachState === 'connect' || attachState === 'ask';
  const ids = {
    project: useId(),
    stage: useId(),
    doers: useId(),
    supervisor: useId(),
    due: useId(),
    client: useId(),
    steps: useId(),
    description: useId(),
    start: useId(),
    labels: useId(),
    repeats: useId(),
    watchers: useId(),
    files: useId(),
    reminder: useId(),
    name: useId(),
  };
  const variant = mode === 'quick' ? 'chip' : 'field';
  const pending = work.create.isPending;
  const add = t('WorkPage.add');

  const nameOf = (id: string) =>
    work.people.candidates.find((person) => person.userId === id)?.displayName ?? '…';
  const firstName = (id: string) => nameOf(id).split(/\s+/)[0] ?? '';

  const createLabel = useMutation({
    mutationFn: (name: string) => defineWorkLabel(api, organizationSlug, { name, color: 'gray' }),
    onSuccess: async (label) => {
      work.setLabels(new Set(work.labels).add(label.id));
      await queries.invalidateQueries({ queryKey: ['capture-labels', organizationSlug] });
    },
  });

  function openPeople(row: PeopleRow) {
    if (work.projectId === '') {
      work.setFormError(t('NewWork.needProjectFirst'));
      return;
    }
    setPicking(row);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    work.submit(submitter?.dataset['another'] === 'true');
  }

  // The day a date written in the name would set, shown on Due until one is picked (B1).
  const dueShown = work.dueDay !== '' ? work.dueDay : (parseQuickDate(work.title)?.day ?? '');
  const dayValue = (day: string, emptyLabel: string) =>
    day === '' ? (
      emptyLabel
    ) : (
      <span className="tm-wk-inline">
        <CalendarIcon />
        {formatChipDay(day, locale)}
      </span>
    );
  const clientNames = work.projectClients
    .filter((client) => work.clients.includes(client.id) && client.name !== '')
    .map((client) => client.name);

  /** Quick: faces and the row's word ("PK SA Doers"); full: the names ("Peter, Sara"). */
  const peopleValue = (key: PeopleRow, label: string) => {
    const list =
      key === 'doers' ? work.doers : key === 'supervisors' ? work.supervisors : work.watchers;
    if (list.length === 0) {
      return mode === 'quick' ? (
        <span className="tm-wk-inline">
          <PlusIcon />
          {label}
        </span>
      ) : (
        add
      );
    }
    const text =
      mode === 'quick'
        ? label
        : list.length === 1
          ? nameOf(list[0] as string)
          : list.map(firstName).join(', ');
    return <PeopleValue ids={list} nameOf={nameOf} text={text} />;
  };

  /** Full create: a label in the 104 px column, the control filling the row. */
  const row = (id: string, label: string, control: ReactNode, testId?: string) =>
    mode === 'quick' ? (
      <span key={id}>{control}</span>
    ) : (
      <div className="tm-nw-row" data-testid={testId}>
        <span id={id} className="tm-nw-row__label">
          {label}
        </span>
        {control}
      </div>
    );

  const project = row(
    ids.project,
    t('WorkPage.project'),
    <CreateControl
      label={t('WorkPage.project')}
      labelledBy={ids.project}
      variant={variant}
      empty={work.projectId === ''}
      value={
        <span className="tm-wk-inline">
          <FolderIcon />
          <bdi>{work.projectName || t('NewWork.chooseProject')}</bdi>
        </span>
      }
      popover={(close) => (
        <ChoiceList
          label={t('WorkPage.project')}
          choices={work.available.map((entry) => ({ id: entry.id, name: <bdi>{entry.name}</bdi> }))}
          isChosen={(id) => id === work.projectId}
          onChoose={(id) => {
            work.chooseProject(id);
            close();
          }}
        />
      )}
      disabled={pending}
      testId="new-project"
    />,
  );

  const stage = row(
    ids.stage,
    t('WorkPage.stage'),
    <CreateControl
      label={t('WorkPage.stage')}
      labelledBy={ids.stage}
      variant={variant}
      value={
        work.stage ? (
          <StageCapsule stage={work.stage} name={stageName(work.stage, work.stageSet)} />
        ) : (
          t('WorkStages.noStage')
        )
      }
      popover={(close) => (
        <StagePicker
          set={work.stageSet}
          stage={work.stage}
          choices={work.setChoices}
          projectSet={work.projectSet}
          onStage={(next) => {
            work.pickStage(next);
            close();
          }}
          onSet={work.pickSet}
        />
      )}
      disabled={pending || work.stagesLoading}
      testId="new-stage"
    />,
  );

  const peopleControl = (key: PeopleRow, id: string, label: string, testId: string) =>
    row(
      id,
      label,
      <CreateControl
        label={label}
        labelledBy={id}
        variant={variant}
        empty={
          (key === 'doers' ? work.doers : key === 'supervisors' ? work.supervisors : work.watchers)
            .length === 0
        }
        value={peopleValue(key, label)}
        onAction={() => openPeople(key)}
        disabled={pending}
        testId={testId}
      />,
    );

  const due = row(
    ids.due,
    t('WorkPage.due'),
    <CreateControl
      label={t('WorkPage.due')}
      labelledBy={ids.due}
      variant={variant}
      empty={dueShown === ''}
      value={dayValue(dueShown, mode === 'quick' ? t('WorkPage.due') : add)}
      popover={(close) => (
        <DueDatePicker
          heading={t('DueDatePicker.dueHeading')}
          value={dueShown}
          min={work.startDay}
          {...(now === undefined ? {} : { now })}
          onSet={(day) => {
            work.setDueDay(day ?? '');
            close();
          }}
          onClose={close}
        />
      )}
      disabled={pending}
      testId="new-due"
    />,
  );

  const client = row(
    ids.client,
    t('WorkPage.client'),
    <CreateControl
      label={t('WorkPage.client')}
      labelledBy={ids.client}
      variant={variant}
      empty={clientNames.length === 0}
      value={
        clientNames.length === 0 ? (
          <span className="tm-wk-inline">
            <span className="tm-wk-client-dot" aria-hidden="true" />
            {mode === 'quick' ? t('WorkPage.client') : t('WorkPage.audienceInternal')}
          </span>
        ) : (
          <span className="tm-wk-inline">
            <span className="tm-wk-client-dot" aria-hidden="true" />
            <bdi>{clientNames.join(', ')}</bdi>
            {mode === 'full'
              ? ` · ${t(work.clientAudience === 'client_visible' ? 'NewWork.canFollow' : 'NewWork.mustAct')}`
              : null}
          </span>
        )
      }
      popover={() => <ClientEditor work={work} />}
      disabled={pending}
      testId="new-client"
    />,
  );

  const footer = (
    <div className="tm-nw__foot">
      {mode === 'quick' && onAllFields ? (
        <Button type="button" tone="text" size="large" flush onClick={onAllFields}>
          {t('NewWork.allFields')}
        </Button>
      ) : mode === 'full' ? (
        <Button type="submit" tone="text" size="large" flush disabled={pending} data-another="true">
          {t('NewWork.createAndAnother')}
        </Button>
      ) : null}
      <span className="tm-nw__foot-end">
        {onClose ? (
          <Button
            type="button"
            tone="text"
            size="large"
            className="tm-nw__cancel"
            onClick={onClose}
          >
            {t('NewWork.cancel')}
          </Button>
        ) : null}
        <Button
          type="submit"
          tone="lime"
          size="large"
          loading={pending}
          disabled={work.available.length === 0}
        >
          {t('NewWork.create')}
        </Button>
      </span>
    </div>
  );

  return (
    <form
      className="tm-nw"
      data-mode={mode}
      data-layout={layout}
      noValidate
      onSubmit={onSubmit}
      aria-labelledby={titleId}
    >
      <div className="tm-nw__head">
        <h2 id={titleId} className="tm-nw__title">
          {t('NewWork.title')}
        </h2>
        {onClose ? (
          <IconButton
            size="small"
            className="tm-nw__close"
            label={t('NewWork.close')}
            icon={<CloseIcon />}
            onClick={onClose}
          />
        ) : null}
        <Button
          type="submit"
          tone="lime"
          size="large"
          className="tm-nw__head-create"
          loading={pending}
        >
          {t('NewWork.create')}
        </Button>
      </div>

      <div className="tm-nw__name">
        <label htmlFor={ids.name} className="tm-visually-hidden">
          {t('WorkPage.renameLabel')}
        </label>
        <input
          id={ids.name}
          className="tm-nw__name-input"
          value={work.title}
          maxLength={300}
          dir="auto"
          required
          placeholder={t('NewWork.namePlaceholder')}
          // The dialog opens to write a name: the box is where the person starts.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={layout === 'dialog'}
          onChange={(event) => work.setTitle(event.target.value)}
        />
        <VoiceControl input={voice} />
      </div>

      {mode === 'quick' ? (
        <div className="tm-nw__chips" role="group" aria-label={t('NewWork.details')}>
          {project}
          {stage}
          {peopleControl('doers', ids.doers, t('WorkPage.doers'), 'new-doers')}
          {peopleControl('supervisors', ids.supervisor, t('WorkPage.supervisor'), 'new-supervisor')}
          {due}
          {client}
        </div>
      ) : (
        <div className="tm-nw__rows">
          {project}
          {stage}
          {peopleControl('doers', ids.doers, t('WorkPage.doers'), 'new-doers')}
          {peopleControl('supervisors', ids.supervisor, t('WorkPage.supervisor'), 'new-supervisor')}
          {due}
          {client}
          <div className="tm-nw-row tm-nw-row--block">
            <span id={ids.steps} className="tm-nw-row__label">
              {t('WorkSteps.heading')}
            </span>
            <CreateSteps
              api={api}
              organizationSlug={organizationSlug}
              steps={work.steps}
              onChange={work.setSteps}
              labelledBy={ids.steps}
            />
          </div>
          <div className="tm-nw-row tm-nw-row--block">
            <label htmlFor={ids.description} className="tm-nw-row__label">
              {t('WorkDetail.description')}
            </label>
            <textarea
              id={ids.description}
              className="tm-wk-textarea tm-nw__description"
              value={work.description}
              maxLength={20000}
              dir="auto"
              rows={layout === 'page' ? 4 : 1}
              placeholder={t('WorkPage.addDescription')}
              onChange={(event) => work.setDescription(event.target.value)}
            />
          </div>

          <button
            type="button"
            className="tm-nw-more"
            aria-expanded={more}
            onClick={() => setMore(!more)}
          >
            <span className="tm-nw-more__label">{t('NewWork.more')}</span>
            {more ? null : <span className="tm-nw-more__list">{t('NewWork.moreList')}</span>}
            <span className="tm-nw-more__chevron" data-open={more || undefined}>
              <ChevronDownIcon />
            </span>
          </button>

          {more ? (
            <>
              {row(
                ids.start,
                t('WorkPage.start'),
                <CreateControl
                  label={t('WorkPage.start')}
                  labelledBy={ids.start}
                  variant="field"
                  empty={work.startDay === ''}
                  value={dayValue(work.startDay, add)}
                  popover={(close) => (
                    <DueDatePicker
                      heading={t('DueDatePicker.startHeading')}
                      value={work.startDay}
                      {...(now === undefined ? {} : { now })}
                      onSet={(day) => {
                        work.setStartDay(day ?? '');
                        close();
                      }}
                      onClose={close}
                    />
                  )}
                  disabled={pending}
                  testId="new-start"
                />,
              )}
              {row(
                ids.labels,
                t('WorkPage.labels'),
                <CreateControl
                  label={t('WorkPage.labels')}
                  labelledBy={ids.labels}
                  variant="field"
                  empty={work.labels.size === 0}
                  value={
                    work.labels.size === 0
                      ? add
                      : (work.workLabels.data ?? [])
                          .filter((label) => work.labels.has(label.id))
                          .map((label) => label.name)
                          .join(', ')
                  }
                  popover={() => (
                    <CaptureLabelPicker
                      labels={work.workLabels.data ?? []}
                      selected={work.labels}
                      onToggle={(id) => {
                        const next = new Set(work.labels);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        work.setLabels(next);
                      }}
                      onCreate={(name) => createLabel.mutate(name)}
                      creating={createLabel.isPending}
                      createError={createLabel.isError ? describe(createLabel.error) : null}
                    />
                  )}
                  disabled={pending}
                  testId="new-labels"
                />,
              )}
              {row(
                ids.repeats,
                t('WorkPage.repeats'),
                <CreateControl
                  label={t('WorkPage.repeats')}
                  labelledBy={ids.repeats}
                  variant="field"
                  value={work.repeat ? t(`WorkPage.repeat.${work.repeat}`) : t('WorkPage.repeatNo')}
                  popover={(close) => (
                    <ChoiceList
                      label={t('WorkPage.repeats')}
                      choices={[
                        { id: 'no', name: t('WorkPage.repeatNo') },
                        ...WORK_ITEM_RECURRENCE_FREQS.map((freq) => ({
                          id: freq,
                          name: t(`WorkPage.repeat.${freq}`),
                        })),
                      ]}
                      isChosen={(id) => (work.repeat ?? 'no') === id}
                      onChoose={(id) => {
                        work.setRepeat(id === 'no' ? null : id);
                        close();
                      }}
                    />
                  )}
                  disabled={pending}
                  testId="new-repeats"
                />,
              )}
              {peopleControl('watchers', ids.watchers, t('WorkPage.watchers'), 'new-watchers')}
              {row(
                ids.files,
                t('NewWork.files'),
                <CreateControl
                  label={t('NewWork.files')}
                  labelledBy={ids.files}
                  variant="field"
                  empty={
                    work.files.length + work.driveFiles.length + work.oneDriveFiles.length === 0
                  }
                  value={
                    <span className="tm-wk-inline">
                      <FileIcon />
                      {work.files.length + work.driveFiles.length + work.oneDriveFiles.length === 0
                        ? t('NewWork.attach')
                        : t('NewWork.fileCount', {
                            count:
                              work.files.length +
                              work.driveFiles.length +
                              work.oneDriveFiles.length,
                          })}
                    </span>
                  }
                  popover={() =>
                    noStorage ? (
                      <NoStorageAttach
                        organizationSlug={organizationSlug}
                        client={api}
                        state={attachState}
                      />
                    ) : (
                      <div className="tm-nw-files">
                        <CaptureAttachmentPicker
                          files={work.files}
                          onAdd={(picked) => work.setFiles([...work.files, ...picked])}
                          onRemove={(index) =>
                            work.setFiles(work.files.filter((_, at) => at !== index))
                          }
                          disabled={pending}
                        />
                        <div className="tm-cloud-attach">
                          <DriveAttachPicker
                            organizationSlug={organizationSlug}
                            client={api}
                            picked={work.driveFiles}
                            onPick={(picked) => work.setDriveFiles([...work.driveFiles, ...picked])}
                            onRemove={(id) =>
                              work.setDriveFiles(work.driveFiles.filter((file) => file.id !== id))
                            }
                            projectId={work.projectId}
                            disabled={pending}
                          />
                          <OneDriveAttachPicker
                            organizationSlug={organizationSlug}
                            client={api}
                            picked={work.oneDriveFiles}
                            onPick={(picked) =>
                              work.setOneDriveFiles([...work.oneDriveFiles, ...picked])
                            }
                            onRemove={(itemId) =>
                              work.setOneDriveFiles(
                                work.oneDriveFiles.filter((file) => file.itemId !== itemId),
                              )
                            }
                            projectId={work.projectId}
                            disabled={pending}
                          />
                        </div>
                      </div>
                    )
                  }
                  disabled={pending}
                  testId="new-files"
                />,
              )}
              <div className="tm-nw-row" data-testid="new-reminder">
                <label htmlFor={ids.reminder} className="tm-nw-row__label">
                  {t('WorkPage.reminder')}
                </label>
                <input
                  id={ids.reminder}
                  type="datetime-local"
                  className="tm-wk-input tm-nw-select"
                  value={work.reminder}
                  disabled={pending}
                  onChange={(event) => work.setReminder(event.target.value)}
                />
              </div>
            </>
          ) : null}
        </div>
      )}

      {work.uploads.rows.length > 0 ? (
        <ul className="tm-upload-list">
          {work.uploads.rows.map((upload) => (
            <UploadProgressItem
              key={upload.id}
              row={upload}
              onCancel={work.uploads.cancel}
              onRetry={work.uploads.retry}
              onRemove={(gone) => work.uploads.remove(gone.id)}
            />
          ))}
        </ul>
      ) : null}

      {work.formError ? (
        <InlineAlert tone="danger" title={t('NewWork.checkTitle')} live>
          {work.formError}
        </InlineAlert>
      ) : null}
      {work.create.isError ? (
        <InlineAlert tone="danger" title={t('NewWork.failed')} live>
          {describe(work.create.error)}
        </InlineAlert>
      ) : null}
      {work.created ? (
        <InlineAlert tone="success" title={t('NewWork.created')} live>
          <bdi>{work.created.item.title}</bdi>{' '}
          <Link href={`/${organizationSlug}/work/${encodeURIComponent(work.created.item.id)}`}>
            {t('NewWork.openIt')}
          </Link>
        </InlineAlert>
      ) : null}
      {work.created && work.created.failures.length > 0 ? (
        <InlineAlert tone="warning" title={t('NewWork.extrasTitle')} live>
          {work.created.failures.join(' ')}
        </InlineAlert>
      ) : null}
      {work.available.length === 0 && work.projects.isSuccess ? (
        <InlineAlert tone="neutral" title={t('NewWork.noProject')}>
          <Link href={`/${organizationSlug}/projects`}>
            <PlusIcon /> {t('NewWork.makeProject')}
          </Link>
        </InlineAlert>
      ) : null}

      {footer}

      {picking !== null ? (
        <PeoplePickerDialog
          title={t(
            picking === 'doers'
              ? 'WorkPeople.pickDoers'
              : picking === 'supervisors'
                ? 'WorkPeople.pickSupervisors'
                : 'WorkPeople.pickWatchers',
          )}
          projectName={work.projectName}
          candidates={work.people.candidates}
          loading={work.people.loading}
          initial={
            picking === 'doers'
              ? work.doers
              : picking === 'supervisors'
                ? work.supervisors
                : work.watchers
          }
          showLeadHint={picking === 'doers'}
          removeHint={picking === 'watchers'}
          saving={false}
          onSave={(chosen) => {
            if (picking === 'doers') work.setDoers(chosen);
            else if (picking === 'supervisors') work.setSupervisors(chosen);
            else work.setWatchers(chosen);
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
          {...(picking === 'supervisors' ? {} : { teams: { api, organizationSlug } })}
        />
      ) : null}
    </form>
  );
}

/** Client (Figma "Nile Foods · can follow"): the project's clients, and whether they follow or act. */
function ClientEditor({ work }: { work: NewWorkState }) {
  const t = useA6T();
  if (work.projectId === '')
    return <p className="tm-wk-section__empty">{t('NewWork.needProjectFirst')}</p>;
  if (work.projectClients.length === 0) {
    return <p className="tm-wk-section__empty">{t('NewWork.noClients')}</p>;
  }
  return (
    <div className="tm-nw-client">
      <ChoiceList
        label={t('WorkPage.client')}
        choices={[
          { id: '', name: t('WorkPage.audienceInternal') },
          ...work.projectClients.map((client) => ({
            id: client.id,
            name: (
              <span className="tm-wk-inline">
                <span className="tm-wk-client-dot" aria-hidden="true" />
                <bdi>{client.name}</bdi>
              </span>
            ),
          })),
        ]}
        isChosen={(id) => (id === '' ? work.clients.length === 0 : work.clients.includes(id))}
        onChoose={(id) =>
          work.setClients(
            id === ''
              ? []
              : work.clients.includes(id)
                ? work.clients.filter((entry) => entry !== id)
                : [...work.clients, id],
          )
        }
      />
      {work.clients.length > 0 ? (
        <>
          <hr className="tm-wk-menu__rule" />
          <ChoiceList
            label={t('WorkPage.whoSees')}
            choices={[
              { id: 'client_visible' as const, name: t('WorkPage.audienceFollow') },
              { id: 'client_action_required' as const, name: t('WorkPage.audienceAction') },
            ]}
            isChosen={(id) => work.clientAudience === id}
            onChoose={work.setClientAudience}
          />
        </>
      ) : null}
    </div>
  );
}
