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
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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
  organizationName,
  client,
}: WorkFormsScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

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
      title="Intake forms"
      description="Reusable intake definitions your team fills in to create a work item."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-form-new-heading">
        <h2 id="tm-form-new-heading" className="tm-eyebrow">
          New form
        </h2>
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <Field
            label="Name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint="A short handle, such as New client request."
            required
          />

          <fieldset className="tm-stack tm-fieldset">
            <legend className="tm-field__label">Fields</legend>
            {draftFields.map((field, index) => (
              <div key={index} className="tm-row tm-row--wrap">
                <Field
                  label={`Field ${index + 1} label`}
                  name={`field-label-${index}`}
                  value={field.label}
                  onChange={(event) => updateDraft(index, { label: event.target.value })}
                />
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor={`tm-field-type-${index}`}>
                    Field {index + 1} type
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
                        {type}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="tm-field tm-field--checkbox">
                  <label className="tm-field__label" htmlFor={`tm-field-required-${index}`}>
                    Field {index + 1} required
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
            <div className="tm-row">
              <Button
                type="button"
                tone="outline"
                size="accessible"
                onClick={() => setDraftFields((current) => [...current, EMPTY_FIELD])}
              >
                Add field
              </Button>
            </div>
          </fieldset>

          {create.isError ? (
            <InlineAlert tone="danger" title="Could not create the form" live>
              {describeError(create.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={create.isPending}
              loadingLabel="Creating"
              disabled={!canCreate}
            >
              Create form
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-form-list-heading">
        <h2 id="tm-form-list-heading" className="tm-eyebrow">
          Forms
        </h2>

        {created ? (
          <InlineAlert tone="success" title="Work item created from the form" live>
            <p className="tm-prose">
              <Link href={`/${organizationSlug}/work/${created.id}`}>
                Open &ldquo;{created.title}&rdquo;
              </Link>{' '}
              to work on the new item.
            </p>
          </InlineAlert>
        ) : null}

        {forms.isError ? (
          <InlineAlert tone="danger" title="Could not load the forms" live>
            {describeError(forms.error)}
          </InlineAlert>
        ) : null}

        {forms.isPending ? (
          <LoadingRegion label="Loading the forms.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!forms.isPending && !forms.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No forms yet">
            Create a form above. Once you have one, you can fill it in to create a work item.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-form-select">
              Form to fill in
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
              <option value="">Choose a form…</option>
              {rows.map((form) => (
                <option key={form.id} value={form.id}>
                  {form.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {activeForm ? (
          <form
            className="tm-stack"
            noValidate
            aria-label={`Fill in ${activeForm.name}`}
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (canSubmit) submit.mutate(activeForm);
            }}
          >
            {available.length > 0 ? (
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-form-project">
                  Project
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
              <InlineAlert tone="neutral" title="No projects yet">
                A work item is created in a project. Once a project exists, you can submit a form.
              </InlineAlert>
            )}

            <Field
              label="Work item title"
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
                      setChecks((current) => ({ ...current, [field.label]: event.target.checked }))
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
              <InlineAlert tone="danger" title="Could not submit the form" live>
                {describeError(submit.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={submit.isPending}
                loadingLabel="Submitting"
                disabled={!canSubmit}
              >
                Create work item
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
