'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  defineWorkCustomField,
  listItemCustomFields,
  listWorkCustomFields,
  removeWorkCustomField,
  setItemCustomFieldValue,
  WORK_CUSTOM_FIELD_TYPES,
  type WorkCustomFieldType,
  type WorkCustomFieldValue,
} from '../../lib/api/work-custom-fields';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface WorkCustomFieldsViewProps {
  organizationSlug: string;
  organizationName: string;
  workItemId: string;
  client?: ApiClient;
}

/**
 * **Work item custom fields (module Work, x306).**
 *
 * `38-MODULE-MAP` §Work management (custom metadata), `22-SCREEN` §Work item detail. A studio defines
 * reusable custom fields (a text/number/select attribute) behind `org.manage`; a member sets a value
 * per work item behind `work.update` and reads the resolved field+value map behind `work.read`. Two
 * panels: the field-definition admin list, and the per-item value editor.
 */
export function WorkCustomFieldsView({
  organizationSlug,
  organizationName,
  workItemId,
  client,
}: WorkCustomFieldsViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const definitionsKey = ['work-custom-fields', organizationSlug];
  const valuesKey = ['work-custom-field-values', organizationSlug, workItemId];

  const definitions = useQuery({
    queryKey: definitionsKey,
    queryFn: () => listWorkCustomFields(api, organizationSlug),
  });

  const values = useQuery({
    queryKey: valuesKey,
    queryFn: () => listItemCustomFields(api, organizationSlug, workItemId),
  });

  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [fieldType, setFieldType] = useState<WorkCustomFieldType>('text');
  const [optionsText, setOptionsText] = useState('');

  const define = useMutation({
    mutationFn: () =>
      defineWorkCustomField(api, organizationSlug, {
        key: key.trim(),
        name: name.trim(),
        fieldType,
        options:
          fieldType === 'select'
            ? optionsText
                .split(',')
                .map((option) => option.trim())
                .filter((option) => option !== '')
            : null,
      }),
    onSuccess: async () => {
      setKey('');
      setName('');
      setOptionsText('');
      setFieldType('text');
      await queryClient.invalidateQueries({ queryKey: definitionsKey });
      await queryClient.invalidateQueries({ queryKey: valuesKey });
    },
  });

  const remove = useMutation({
    mutationFn: (fieldKey: string) => removeWorkCustomField(api, organizationSlug, fieldKey),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: definitionsKey });
      await queryClient.invalidateQueries({ queryKey: valuesKey });
    },
  });

  const canDefine =
    key.trim() !== '' &&
    name.trim() !== '' &&
    (fieldType !== 'select' || optionsText.trim() !== '') &&
    !define.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Custom fields"
      description="Define custom fields for work items and set their values on this item."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-custom-fields-define-heading">
        <h2 id="tm-custom-fields-define-heading" className="tm-eyebrow">
          Field definitions
        </h2>
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canDefine) define.mutate();
          }}
        >
          <Field
            label="Key"
            name="key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            hint="A stable, unique key for the field, e.g. priority."
            required
          />
          <Field
            label="Name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          <Select
            label="Type"
            name="fieldType"
            value={fieldType}
            onChange={(event) => setFieldType(event.target.value as WorkCustomFieldType)}
          >
            {WORK_CUSTOM_FIELD_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </Select>
          {fieldType === 'select' ? (
            <Field
              label="Options"
              name="options"
              value={optionsText}
              onChange={(event) => setOptionsText(event.target.value)}
              hint="Comma-separated list of allowed values."
              required
            />
          ) : null}
          {define.isError ? (
            <InlineAlert tone="danger" title="Could not define the field" live>
              {describeError(define.error)}
            </InlineAlert>
          ) : null}
          <div className="tm-row">
            <Button type="submit" tone="ink" disabled={!canDefine} loading={define.isPending}>
              Define field
            </Button>
          </div>
        </form>

        {definitions.isError ? (
          <InlineAlert tone="danger" title="Could not load the fields" live>
            {describeError(definitions.error)}
          </InlineAlert>
        ) : null}
        {definitions.isPending ? (
          <LoadingRegion label="Loading the fields.">
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}
        {!definitions.isPending && !definitions.isError ? (
          <ul className="tm-stack" aria-label="Custom field definitions">
            {definitions.data.map((definition) => (
              <li key={definition.id} className="tm-row tm-row--between">
                <span>
                  <strong>{definition.name}</strong> <code>{definition.key}</code> ·{' '}
                  {definition.fieldType}
                </span>
                <Button
                  type="button"
                  tone="text"
                  onClick={() => remove.mutate(definition.key)}
                  disabled={remove.isPending}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-custom-fields-values-heading">
        <h2 id="tm-custom-fields-values-heading" className="tm-eyebrow">
          Values on this item
        </h2>
        {values.isError ? (
          <InlineAlert tone="danger" title="Could not load the values" live>
            {describeError(values.error)}
          </InlineAlert>
        ) : null}
        {values.isPending ? (
          <LoadingRegion label="Loading the values.">
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}
        {!values.isPending && !values.isError ? (
          <ul className="tm-stack" aria-label="Custom field values">
            {values.data.map((field) => (
              <FieldValueEditor
                key={field.key}
                field={field}
                onSave={(value) =>
                  setItemCustomFieldValue(api, organizationSlug, workItemId, field.key, value)
                }
                onSaved={async () => {
                  await queryClient.invalidateQueries({ queryKey: valuesKey });
                }}
              />
            ))}
          </ul>
        ) : null}
      </section>
    </AppShell>
  );
}

function FieldValueEditor({
  field,
  onSave,
  onSaved,
}: {
  field: WorkCustomFieldValue;
  onSave: (value: string) => Promise<WorkCustomFieldValue>;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(field.value ?? '');

  const save = useMutation({
    mutationFn: () => onSave(draft),
    onSuccess: () => onSaved(),
  });

  return (
    <li className="tm-stack">
      <form
        className="tm-row"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (draft.trim() !== '') save.mutate();
        }}
      >
        {field.fieldType === 'select' && field.options ? (
          <Select
            label={field.name}
            name={`value-${field.key}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          >
            <option value="">Select…</option>
            {field.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        ) : (
          <Field
            label={field.name}
            name={`value-${field.key}`}
            type={field.fieldType === 'number' ? 'number' : 'text'}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        )}
        <Button
          type="submit"
          tone="ink"
          disabled={draft.trim() === '' || save.isPending}
          loading={save.isPending}
        >
          Save
        </Button>
      </form>
      {save.isError ? (
        <InlineAlert tone="danger" title="Could not save the value" live>
          {describeError(save.error)}
        </InlineAlert>
      ) : null}
    </li>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped. Try again.';
  return 'Something went wrong.';
}
