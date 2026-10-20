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
import { useT } from '../../lib/i18n/use-t';

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
  const t = useT();
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
        {t('AutomationVariablesView.heading')}
      </h2>
      <p className="tm-muted">{t('AutomationVariablesView.lede')}</p>

      <form
        className="tm-stack"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        <Field
          label={t('AutomationVariablesView.keyLabel')}
          name="key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          hint={t('AutomationVariablesView.keyHint')}
          required
        />

        <Field
          label={t('AutomationVariablesView.valueLabel')}
          name="value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          hint={t('AutomationVariablesView.valueHint')}
        />

        {save.isError ? (
          <InlineAlert tone="danger" title={t('AutomationVariablesView.errorSaveTitle')} live>
            {describeError(t, save.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={save.isPending}
            loadingLabel={t('AutomationVariablesView.saving')}
            disabled={!canSave}
          >
            {t('AutomationVariablesView.saveButton')}
          </Button>
        </div>
      </form>

      {remove.isError ? (
        <InlineAlert tone="danger" title={t('AutomationVariablesView.errorRemoveTitle')} live>
          {describeError(t, remove.error)}
        </InlineAlert>
      ) : null}

      {variables.isError ? (
        <InlineAlert tone="danger" title={t('AutomationVariablesView.errorLoadTitle')} live>
          {describeError(t, variables.error)}
        </InlineAlert>
      ) : null}

      {variables.isPending ? (
        <LoadingRegion label={t('AutomationVariablesView.loadingLabel')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!variables.isPending && !variables.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title={t('AutomationVariablesView.emptyTitle')}>
          {t('AutomationVariablesView.emptyBody')}
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
          aria-label={t('AutomationVariablesView.tableLabel')}
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              {t('AutomationVariablesView.captionPrefix')} {rows.length}{' '}
              {t('AutomationVariablesView.captionSuffix')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('AutomationVariablesView.colKey')}</th>
                <th scope="col">{t('AutomationVariablesView.colValue')}</th>
                <th scope="col">
                  <span className="tm-visually-hidden">
                    {t('AutomationVariablesView.actionsColumn')}
                  </span>
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
                      loadingLabel={t('AutomationVariablesView.removing')}
                      onClick={() => remove.mutate(variable.key)}
                    >
                      {t('AutomationVariablesView.remove')}
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

function describeError(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('AutomationVariablesView.errorApiUnreachable');
  return t('AutomationVariablesView.errorGeneric');
}
