'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  defineField,
  deleteField,
  listFieldDefinitions,
  listProjectCustomFields,
  setProjectCustomFieldValue,
} from '../../lib/api/project-custom-fields';
import type { ProjectCustomFieldType } from '../../lib/api/project-custom-fields';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ProjectCustomFieldsViewProps {
  organizationSlug: string;
  /** The project whose custom-field values this view edits — from the `[projectId]` route segment. */
  projectId: string;
  client?: ApiClient | undefined;
}

const TYPE_LABELS: Readonly<Record<ProjectCustomFieldType, string>> = {
  text: 'Text',
  number: 'Number',
  select: 'Select (choose one)',
};

/**
 * **Project custom fields (x310).**
 *
 * `38-MODULE-MAP` §Projects & portfolio (custom metadata) and `22-SCREEN` §Project detail: an
 * organization defines custom fields for its projects, and each project carries a value per field.
 * This view is two panels — a field-definition admin list (define a field, remove one; behind
 * `org.manage` on the server) and a per-project editor that sets this project's value for each field
 * (behind `project.manage`). As on the sibling screens, **authorization is the API's**: a caller
 * without the capability gets the ordinary refusal, which `describeError()` turns into a sentence.
 */
export function ProjectCustomFieldsView({
  organizationSlug,
  projectId,
  client,
}: ProjectCustomFieldsViewProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<ProjectCustomFieldType>('text');
  const [options, setOptions] = useState('');
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});

  const definitionsKey = ['project-custom-field-definitions', organizationSlug] as const;
  const valuesKey = ['project-custom-fields', organizationSlug, projectId] as const;

  const definitions = useQuery({
    queryKey: definitionsKey,
    queryFn: () => listFieldDefinitions(api, organizationSlug),
  });

  const values = useQuery({
    queryKey: valuesKey,
    queryFn: () => listProjectCustomFields(api, organizationSlug, projectId),
  });

  const invalidate = () => {
    void queries.invalidateQueries({ queryKey: definitionsKey });
    void queries.invalidateQueries({ queryKey: valuesKey });
  };

  const define = useMutation({
    mutationFn: () =>
      defineField(api, organizationSlug, {
        key: key.trim(),
        name: name.trim(),
        type,
        ...(type === 'select'
          ? {
              options: options
                .split(',')
                .map((option) => option.trim())
                .filter((option) => option !== ''),
            }
          : {}),
      }),
    onSuccess: (created) => {
      invalidate();
      setKey('');
      setName('');
      setType('text');
      setOptions('');
      setMessage(`Defined "${created.name}".`);
    },
    onError: (error) => setMessage(describeError(error)),
  });

  const remove = useMutation({
    mutationFn: (fieldKey: string) => deleteField(api, organizationSlug, fieldKey),
    onSuccess: () => {
      invalidate();
      setMessage('Field removed.');
    },
    onError: (error) => setMessage(describeError(error)),
  });

  const save = useMutation({
    mutationFn: (fieldKey: string) =>
      setProjectCustomFieldValue(
        api,
        organizationSlug,
        projectId,
        fieldKey,
        drafts[fieldKey] ?? '',
      ),
    onSuccess: (saved) => {
      invalidate();
      setMessage(`Saved "${saved.name}".`);
    },
    onError: (error) => setMessage(describeError(error)),
  });

  const onDefine = (event: FormEvent) => {
    event.preventDefault();
    define.mutate();
  };

  return (
    <div className="tm-stack">
      {message ? (
        <InlineAlert tone="neutral" title={message} live>
          {message}
        </InlineAlert>
      ) : null}

      <section className="tm-panel tm-stack" aria-labelledby="tm-pcf-define">
        <h2 id="tm-pcf-define" className="tm-eyebrow">
          Custom field definitions
        </h2>

        <form className="tm-stack" onSubmit={onDefine}>
          <Field
            label="Key"
            hint="Lower_snake_case; how the field is addressed."
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <Field label="Name" value={name} onChange={(event) => setName(event.target.value)} />
          <Select
            label="Type"
            value={type}
            onChange={(event) => setType(event.target.value as ProjectCustomFieldType)}
          >
            {(Object.keys(TYPE_LABELS) as ProjectCustomFieldType[]).map((option) => (
              <option key={option} value={option}>
                {TYPE_LABELS[option]}
              </option>
            ))}
          </Select>
          {type === 'select' ? (
            <Field
              label="Options"
              hint="Comma-separated choices."
              value={options}
              onChange={(event) => setOptions(event.target.value)}
            />
          ) : null}
          <Button type="submit" disabled={define.isPending}>
            Define field
          </Button>
        </form>

        {definitions.isError ? (
          <InlineAlert tone="danger" title="Could not load field definitions" live>
            {describeError(definitions.error)}
          </InlineAlert>
        ) : null}

        {definitions.isPending ? (
          <LoadingRegion label="Loading field definitions.">
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!definitions.isPending && !definitions.isError && (definitions.data?.length ?? 0) === 0 ? (
          <InlineAlert tone="neutral" title="No custom fields yet">
            Define a field above; it becomes editable on every project.
          </InlineAlert>
        ) : null}

        {definitions.data && definitions.data.length > 0 ? (
          <ul className="tm-list" aria-label="Custom field definitions">
            {definitions.data.map((definition) => (
              <li key={definition.fieldKey} className="tm-row">
                <span>
                  {definition.name} ({TYPE_LABELS[definition.fieldType]})
                </span>
                <Button
                  type="button"
                  tone="text"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(definition.fieldKey)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-pcf-values">
        <h2 id="tm-pcf-values" className="tm-eyebrow">
          This project&rsquo;s values
        </h2>

        {values.isError ? (
          <InlineAlert tone="danger" title="Could not load this project's values" live>
            {describeError(values.error)}
          </InlineAlert>
        ) : null}

        {values.isPending ? (
          <LoadingRegion label="Loading this project's values.">
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {values.data && values.data.length > 0 ? (
          <ul className="tm-list" aria-label="Project custom field values">
            {values.data.map((entry) => (
              <li key={entry.fieldKey} className="tm-row">
                {entry.fieldType === 'select' ? (
                  <Select
                    label={entry.name}
                    value={drafts[entry.fieldKey] ?? entry.value ?? ''}
                    onChange={(event) =>
                      setDrafts((prior) => ({ ...prior, [entry.fieldKey]: event.target.value }))
                    }
                  >
                    <option value="">—</option>
                    {entry.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Field
                    label={entry.name}
                    type={entry.fieldType === 'number' ? 'number' : 'text'}
                    value={drafts[entry.fieldKey] ?? entry.value ?? ''}
                    onChange={(event) =>
                      setDrafts((prior) => ({ ...prior, [entry.fieldKey]: event.target.value }))
                    }
                  />
                )}
                <Button
                  type="button"
                  tone="outline"
                  disabled={save.isPending}
                  onClick={() => save.mutate(entry.fieldKey)}
                >
                  Save
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
