'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  addDocumentTemplateVariable,
  listDocumentTemplateVariables,
  removeDocumentTemplateVariable,
  type DocumentTemplateVariableType,
} from '../../lib/api/document-template-variables';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface DocumentTemplateVariablesScreenProps {
  organizationSlug: string;
  organizationName: string;
  templateId: string;
  client?: ApiClient;
}

const TYPES: readonly { value: DocumentTemplateVariableType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'date', label: 'Date' },
  { value: 'number', label: 'Number' },
];

/**
 * **DOC-04 template variables (x130).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Docs DOC-04. A disjoint surface from the DOC-04 template
 * gallery (`DocumentTemplatesScreen`): this screen owns one template's declared variables — the
 * named placeholders it exposes. It lists them key-ascending, adds one (key, label, type, required),
 * and removes one.
 *
 * ## What it does, and what it cannot
 *
 * - **Variables are declared, not yet substituted.** DOC-04's substitution at render and defaults
 *   are deferred (NS-13); a variable here is only a declaration a later slice will fill.
 * - **A variable is added and removed, never edited.** The API ships no editor, so there is no
 *   edit control here — remove and re-add is the shape until an editor lands.
 */
export function DocumentTemplateVariablesScreen({
  organizationSlug,
  organizationName,
  templateId,
  client,
}: DocumentTemplateVariablesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['document-template-variables', organizationSlug, templateId];

  const variables = useQuery({
    queryKey,
    queryFn: () => listDocumentTemplateVariables(api, organizationSlug, templateId),
  });

  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<DocumentTemplateVariableType>('text');
  const [required, setRequired] = useState(false);

  const add = useMutation({
    mutationFn: () =>
      addDocumentTemplateVariable(api, organizationSlug, templateId, {
        key: key.trim(),
        label: label.trim(),
        type,
        required,
      }),
    onSuccess: async () => {
      setKey('');
      setLabel('');
      setType('text');
      setRequired(false);
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const remove = useMutation({
    mutationFn: (variableId: string) =>
      removeDocumentTemplateVariable(api, organizationSlug, templateId, variableId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const rows = variables.data ?? [];
  const canAdd = key.trim() !== '' && label.trim() !== '' && !add.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      title="Template variables"
      description="The named placeholders this template declares. Adding a variable does not change the template body yet."
    >
      <p className="tm-prose">
        <Link href={`/${organizationSlug}/docs/templates`}>Back to templates</Link>
      </p>

      <section className="tm-panel tm-stack" aria-labelledby="tm-var-new-heading">
        <h2 id="tm-var-new-heading" className="tm-eyebrow">
          New variable
        </h2>
        <form
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canAdd) add.mutate();
          }}
        >
          <Field
            label="Key"
            name="key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            hint="The token a document is filled by, such as client_name. Unique within the template."
            required
          />
          <Field
            label="Label"
            name="label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            hint="What a person filling the variable in sees, such as Client name."
            required
          />
          <Select
            label="Type"
            name="type"
            value={type}
            onChange={(event) => setType(event.target.value as DocumentTemplateVariableType)}
            hint="The kind of value this variable holds."
          >
            {TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Checkbox
            label="Required"
            name="required"
            checked={required}
            onChange={(event) => setRequired(event.target.checked)}
            hint="A required variable must be given a value before the template is applied."
          />

          {add.isError ? (
            <InlineAlert tone="danger" title="Could not add the variable" live>
              {describeError(add.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={add.isPending}
              loadingLabel="Adding"
              disabled={!canAdd}
            >
              Add variable
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-var-list-heading">
        <h2 id="tm-var-list-heading" className="tm-eyebrow">
          Declared variables
        </h2>

        {variables.isError ? (
          <InlineAlert tone="danger" title="Could not load the variables" live>
            {describeError(variables.error)}
          </InlineAlert>
        ) : null}

        {remove.isError ? (
          <InlineAlert tone="danger" title="Could not remove that variable" live>
            {describeError(remove.error)}
          </InlineAlert>
        ) : null}

        {variables.isPending ? (
          <LoadingRegion label="Loading the variables.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!variables.isPending && !variables.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No variables yet">
            Add a variable above. Each one is a placeholder this template declares.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow
            // columns (WCAG 2.2 2.1.1), matching the other screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Template variables"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                This template&rsquo;s declared variables, {rows.length} shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Label</th>
                  <th scope="col">Type</th>
                  <th scope="col">Required</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((variable) => (
                  <tr key={variable.id}>
                    <th scope="row" className="tm-table__title">
                      {variable.key}
                    </th>
                    <td>{variable.label}</td>
                    <td>{variable.type}</td>
                    <td>{variable.required ? 'Yes' : 'No'}</td>
                    <td>
                      <Button
                        type="button"
                        tone="outline"
                        size="accessible"
                        loading={remove.isPending && remove.variables === variable.id}
                        loadingLabel="Removing"
                        onClick={() => remove.mutate(variable.id)}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
