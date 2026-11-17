'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createWorkForm,
  listWorkForms,
  submitWorkForm,
  type WorkFormFieldDef,
  type WorkFormFieldType,
  type WorkFormSummary,
} from '../../lib/api/work-forms';
import { listProjects } from '../../lib/api/projects';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/work-planning.css';
import { useOrganizationName } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { WorkFormPublicLink } from './WorkFormPublicLink';
import { WorkFormAttachmentSetting } from './WorkFormAttachmentSetting';

export interface WorkFormsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const FIELD_TYPES: readonly WorkFormFieldType[] = ['text', 'number', 'date', 'checkbox'];

interface DraftField {
  readonly label: string;
  readonly type: WorkFormFieldType;
  readonly required: boolean;
}

const EMPTY_FIELD: DraftField = { label: '', type: 'text', required: false };

/**
 * **WORK intake forms (module 7, x146).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Work ("intake forms"). This screen is disjoint from the
 * Work list, timeline, workload and saved-view screens: it owns the org-scoped intake *forms* a
 * person defines once and reuses. It defines a form (a name and a list of fields), lists the
 * organization's forms, and submits one to create a work item — the durable output of a submission.
 *
 * ## What it does, and what it cannot
 *
 * - **Submission history is not shown.** A submission's record is the work item it creates; the
 *   screen links straight to it. A stored submission log and conditional fields are deferred
 *   (NEXT-SCOPES-13).
 * - **A form is defined, never edited here.** The API grants create and read only this slice, so
 *   there is no edit or delete control — a form is authored and then submitted.
 */
export function WorkFormsScreen({
  organizationSlug,
  organizationName: passedOrganizationName,
  client,
}: WorkFormsScreenProps) {
  const describeError = useDescribeApiError();
  const organizationName = useOrganizationName(organizationSlug, passedOrganizationName);
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const forms = useQuery({
    queryKey: ['work-forms', organizationSlug],
    queryFn: () => listWorkForms(api, organizationSlug),
  });

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const [name, setName] = useState('');
  const [draftFields, setDraftFields] = useState<readonly DraftField[]>([EMPTY_FIELD]);

  const [activeFormId, setActiveFormId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [created, setCreated] = useState<{ id: string; title: string } | null>(null);

  const available = projects.data ?? [];
  const chosenProjectId = projectId !== '' ? projectId : (available[0]?.id ?? '');
  const rows = forms.data ?? [];
  const activeForm = rows.find((form) => form.id === activeFormId) ?? null;

  const create = useMutation({
    mutationFn: () => {
      const fields: WorkFormFieldDef[] = draftFields
        .filter((field) => field.label.trim() !== '')
        .map((field) => ({
          label: field.label.trim(),
          type: field.type,
          required: field.required,
        }));
      return createWorkForm(api, organizationSlug, { name: name.trim(), fields });
    },
    onSuccess: async () => {
      setName('');
      setDraftFields([EMPTY_FIELD]);
      await queryClient.invalidateQueries({ queryKey: ['work-forms', organizationSlug] });
    },
  });

  const submit = useMutation({
    mutationFn: (form: WorkFormSummary) => {
      const payload: Record<string, string | number | boolean> = {};
      for (const field of form.fields) {
        if (field.type === 'checkbox') {
          payload[field.label] = checks[field.label] ?? false;
        } else if (field.type === 'number') {
          const raw = values[field.label];
          if (raw !== undefined && raw !== '') payload[field.label] = Number(raw);
        } else {
          const raw = values[field.label];
          if (raw !== undefined && raw !== '') payload[field.label] = raw;
        }
      }
      return submitWorkForm(api, organizationSlug, form.id, {
        projectId: chosenProjectId,
        title: title.trim(),
        values: payload,
      });
    },
    onSuccess: (workItem) => {
      setCreated({ id: workItem.id, title: workItem.title });
      setTitle('');
      setValues({});
      setChecks({});
    },
  });

  const namedDrafts = draftFields.filter((field) => field.label.trim() !== '');
  const canCreate = name.trim() !== '' && namedDrafts.length > 0 && !create.isPending;
  const canSubmit = activeForm !== null && chosenProjectId !== '' && title.trim() !== '';

  const updateDraft = (index: number, patch: Partial<DraftField>) => {
    setDraftFields((current) =>
      current.map((field, position) => (position === index ? { ...field, ...patch } : field)),
    );
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={t('WorkFormsScreen.title')}
      eyebrow={t('WorkFormsScreen.eyebrow')}
    >
      <div className="wp-forms">
        <section className="wp-forms__builder" aria-labelledby="tm-form-new-heading">
          <h2 id="tm-form-new-heading" className="wp-section-title">
            {t('WorkFormsScreen.builder')}
          </h2>
          <form
            className="wp-stack wp-stack--fill"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canCreate) create.mutate();
            }}
          >
            <Field
              label={t('WorkFormsScreen.formName')}
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              hint={t('WorkFormsScreen.formNameHint')}
              required
            />

            <fieldset className="wp-stack tm-fieldset">
              <legend className="wp-plain-label">{t('WorkFormsScreen.questions')}</legend>
              {draftFields.map((field, index) => (
                <div key={index} className="wp-forms__question">
                  <Field
                    label={`${t('WorkFormsScreen.question')} ${index + 1}`}
                    name={`field-label-${index}`}
                    value={field.label}
                    onChange={(event) => updateDraft(index, { label: event.target.value })}
                  />
                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor={`tm-field-type-${index}`}>
                      {t('WorkFormsScreen.answer')}
                    </label>
                    <select
                      id={`tm-field-type-${index}`}
                      className="tm-field__control"
                      value={field.type}
                      onChange={(event) =>
                        updateDraft(index, { type: event.target.value as WorkFormFieldType })
                      }
                    >
                      {FIELD_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {t(FIELD_TYPE_LABELS[type])}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="wp-forms__check">
                    <label className="wp-plain-label" htmlFor={`tm-field-required-${index}`}>
                      {t('WorkFormsScreen.required')}
                    </label>
                    <input
                      id={`tm-field-required-${index}`}
                      type="checkbox"
                      checked={field.required}
                      onChange={(event) => updateDraft(index, { required: event.target.checked })}
                    />
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="wp-add"
                onClick={() => setDraftFields((current) => [...current, EMPTY_FIELD])}
              >
                {t('WorkFormsScreen.addQuestion')}
              </button>
            </fieldset>

            {create.isError ? (
              <InlineAlert tone="danger" title={t('WorkFormsScreen.createError')} live>
                {describeError(create.error)}
              </InlineAlert>
            ) : null}

            <div className="wp-wide-button">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={create.isPending}
                loadingLabel={t('WorkFormsScreen.creating')}
                disabled={!canCreate}
              >
                {t('WorkFormsScreen.createForm')}
              </Button>
            </div>
            <p className="wp-caption">{t('WorkFormsScreen.caption')}</p>
          </form>
        </section>

        <section className="wp-forms__client" aria-labelledby="tm-form-list-heading">
          <div className="wp-forms__who">
            <span className="wp-forms__orb" aria-hidden="true">
              &#9678;
            </span>
            <span>{t('WorkFormsScreen.whatPersonSees')}</span>
          </div>
          <h2 id="tm-form-list-heading" className="wp-forms__heading">
            {activeForm
              ? activeForm.name
              : `${t('WorkFormsScreen.askPrefix')} ${organizationName} ${t('WorkFormsScreen.askSuffix')}`}
          </h2>

          {created ? (
            <InlineAlert tone="success" title={t('WorkFormsScreen.createdTitle')} live>
              <p className="tm-prose">
                <Link href={`/${organizationSlug}/work/${created.id}`}>
                  {t('WorkFormsScreen.openQuote')}&ldquo;{created.title}&rdquo;
                </Link>{' '}
                {t('WorkFormsScreen.toWorkOn')}
              </p>
            </InlineAlert>
          ) : null}

          {forms.isError ? (
            <InlineAlert tone="danger" title={t('WorkFormsScreen.formsLoadError')} live>
              {describeError(forms.error)}
            </InlineAlert>
          ) : null}

          {forms.isPending ? (
            <LoadingRegion label={t('WorkFormsScreen.formsLoading')}>
              <Skeleton height="44px" />
              <Skeleton height="44px" />
            </LoadingRegion>
          ) : null}

          {!forms.isPending && !forms.isError && rows.length === 0 ? (
            <div className="wp-empty">
              <h3 className="wp-empty__title">{t('WorkFormsScreen.noFormsTitle')}</h3>
              <p className="wp-empty__body">{t('WorkFormsScreen.noFormsBody')}</p>
            </div>
          ) : null}

          {rows.length > 0 ? (
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-form-select">
                {t('WorkFormsScreen.formToFillIn')}
              </label>
              <select
                id="tm-form-select"
                className="tm-field__control"
                value={activeFormId}
                onChange={(event) => {
                  setActiveFormId(event.target.value);
                  setValues({});
                  setChecks({});
                }}
              >
                <option value="">{t('WorkFormsScreen.chooseForm')}</option>
                {rows.map((form) => (
                  <option key={form.id} value={form.id}>
                    {form.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {activeForm ? (
            <WorkFormPublicLink api={api} organizationSlug={organizationSlug} form={activeForm} />
          ) : null}

          {activeForm ? (
            <WorkFormAttachmentSetting
              api={api}
              organizationSlug={organizationSlug}
              form={activeForm}
              projects={available}
            />
          ) : null}

          {activeForm ? (
            <form
              className="wp-stack wp-stack--fill"
              noValidate
              aria-label={`${t('WorkFormsScreen.fillIn')} ${activeForm.name}`}
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                if (canSubmit) submit.mutate(activeForm);
              }}
            >
              {available.length > 0 ? (
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-form-project">
                    {t('WorkFormsScreen.project')}
                  </label>
                  <select
                    id="tm-form-project"
                    className="tm-field__control"
                    value={chosenProjectId}
                    onChange={(event) => setProjectId(event.target.value)}
                  >
                    {available.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="wp-empty">
                  <h3 className="wp-empty__title">{t('WorkFormsScreen.noProjectsTitle')}</h3>
                  <p className="wp-empty__body">{t('WorkFormsScreen.noProjectsBody')}</p>
                </div>
              )}

              <Field
                label={t('WorkFormsScreen.workItemTitle')}
                name="title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
              />

              {activeForm.fields.map((field) =>
                field.type === 'checkbox' ? (
                  <div key={field.label} className="tm-field tm-field--checkbox">
                    <label className="tm-field__label" htmlFor={`tm-value-${field.label}`}>
                      {field.label}
                    </label>
                    <input
                      id={`tm-value-${field.label}`}
                      type="checkbox"
                      checked={checks[field.label] ?? false}
                      onChange={(event) =>
                        setChecks((current) => ({
                          ...current,
                          [field.label]: event.target.checked,
                        }))
                      }
                    />
                  </div>
                ) : (
                  <Field
                    key={field.label}
                    label={field.label}
                    name={`value-${field.label}`}
                    type={
                      field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'
                    }
                    value={values[field.label] ?? ''}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.label]: event.target.value }))
                    }
                    required={field.required}
                  />
                ),
              )}

              {submit.isError ? (
                <InlineAlert tone="danger" title={t('WorkFormsScreen.submitError')} live>
                  {describeError(submit.error)}
                </InlineAlert>
              ) : null}

              <div className="wp-wide-button">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={submit.isPending}
                  loadingLabel={t('WorkFormsScreen.submitting')}
                  disabled={!canSubmit}
                >
                  {t('WorkFormsScreen.createWorkItem')}
                </Button>
              </div>
            </form>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}

/**
 * How each answer type is said to a person (translated; 2026-10-31 live-test fix — these were
 * English-only). The stored value stays the API's key.
 */
const FIELD_TYPE_LABELS = {
  text: 'WorkFormsScreen.typeText',
  number: 'WorkFormsScreen.typeNumber',
  date: 'WorkFormsScreen.typeDate',
  checkbox: 'WorkFormsScreen.typeCheckbox',
} as const satisfies Record<WorkFormFieldType, string>;
