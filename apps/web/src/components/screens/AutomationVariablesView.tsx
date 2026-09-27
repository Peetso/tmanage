'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  deleteAutomationVariable,
  listAutomationVariables,
  upsertAutomationVariable,
} from '../../lib/api/automation-variables';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AutomationVariablesViewProps {
  organizationSlug: string;
  client?: ApiClient;
}

/** The safe-identifier grammar the API enforces on a key; mirrored here to disable the button early. */
const VAR_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/**
 * **Automations & integrations (module 17, x305).**
 *
 * `22-SCREEN-INVENTORY` §AUT (automations); `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations.
 * An org-level, **non-secret** `(key -> value)` map a workflow template may reference. This screen
 * lists the variables and lets an admin add, change or remove one. Every route is gated on the server
 * by `org.manage`, so a member without the capability sees the API's refusal rather than a blank page.
 *
 * ## Non-secret only
 *
 * These variables are **not** a secret store. The copy says so, and the API refuses a key whose name
 * looks secret-like (`password`/`token`/`secret`/`key`) with a 400 — a credential belongs in the
 * separate secret store, not here. A malformed key is likewise the API's 400; the add button mirrors
 * the key grammar so the common mistake is caught before the request.
 */
export function AutomationVariablesView({
  organizationSlug,
  client,
}: AutomationVariablesViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['automation-variables', organizationSlug];

  const variables = useQuery({
    queryKey,
    queryFn: () => listAutomationVariables(api, organizationSlug),
  });

  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  const rows = variables.data ?? [];

  const save = useMutation({
    mutationFn: () => upsertAutomationVariable(api, organizationSlug, key.trim(), value),
    onSuccess: async () => {
      setKey('');
      setValue('');
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const remove = useMutation({
    mutationFn: (variableKey: string) =>
      deleteAutomationVariable(api, organizationSlug, variableKey),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const keyIsValid = VAR_KEY_PATTERN.test(key.trim());
  const canSave = keyIsValid && !save.isPending;

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-automation-variables-heading">
      <h2 id="tm-automation-variables-heading" className="tm-eyebrow">
        Variables
      </h2>
      <p className="tm-muted">
        Non-secret values your automations can reference by name, such as a channel or a threshold.
        Do not store passwords, tokens or other secrets here.
      </p>

      <form
        className="tm-stack"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        <Field
          label="Key"
          name="key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          hint="A letter, then letters, digits or underscore (max 64). Not a secret name."
          required
        />

        <Field
          label="Value"
          name="value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          hint="The non-secret value this variable holds."
        />

        {save.isError ? (
          <InlineAlert tone="danger" title="Could not save the variable" live>
            {describeError(save.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={save.isPending}
            loadingLabel="Saving"
            disabled={!canSave}
          >
            Save variable
          </Button>
        </div>
      </form>

      {remove.isError ? (
        <InlineAlert tone="danger" title="Could not remove the variable" live>
          {describeError(remove.error)}
        </InlineAlert>
      ) : null}

      {variables.isError ? (
        <InlineAlert tone="danger" title="Could not load the variables" live>
          {describeError(variables.error)}
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
          Add a non-secret variable above for your automations to reference.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <div
          className="tm-table-scroll"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
          // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Automation variables"
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              This organization&apos;s automation variables, {rows.length} shown.
            </caption>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Value</th>
                <th scope="col">
                  <span className="tm-visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((variable) => (
                <tr key={variable.key}>
                  <th scope="row" className="tm-table__title">
                    {variable.key}
                  </th>
                  <td>{variable.value}</td>
                  <td>
                    <Button
                      type="button"
                      tone="text"
                      size="compact"
                      loading={remove.isPending && remove.variables === variable.key}
                      loadingLabel="Removing"
                      onClick={() => remove.mutate(variable.key)}
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
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
