'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/docs.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  addDocumentTemplateVariable,
  listDocumentTemplateVariables,
  removeDocumentTemplateVariable,
  type DocumentTemplateVariableType,
} from '../../lib/api/document-template-variables';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

export interface DocumentTemplateVariablesScreenProps {
  organizationSlug: string;
  organizationName: string;
  templateId: string;
  client?: ApiClient;
}

const TYPES: readonly { value: DocumentTemplateVariableType; labelKey: MessageKey }[] = [
  { value: 'text', labelKey: 'DocumentTemplateVariablesScreen.typeText' },
  { value: 'date', labelKey: 'DocumentTemplateVariablesScreen.typeDate' },
  { value: 'number', labelKey: 'DocumentTemplateVariablesScreen.typeNumber' },
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
  const t = useT();
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
      eyebrow={t('DocumentTemplateVariablesScreen.eyebrow')}
      title={t('DocumentTemplateVariablesScreen.title')}
      description={t('DocumentTemplateVariablesScreen.description')}
      actions={
        <Link className="tm-dx-back" href={`/${organizationSlug}/docs/templates`}>
          <span className="tm-dx-back__orb" aria-hidden="true">
            ←
          </span>
          {t('DocumentTemplateVariablesScreen.backToTemplates')}
        </Link>
      }
    >
      <div className="tm-dx tm-dx-split">
        <section className="tm-dx-split__main" aria-labelledby="tm-var-list-heading">
          <h2 id="tm-var-list-heading" className="tm-dx-caption">
            {t('DocumentTemplateVariablesScreen.declaredVariables')}
            {rows.length > 0 ? ` · ${rows.length}` : ''}
          </h2>

          {variables.isError ? (
            <InlineAlert tone="danger" title={t('DocumentTemplateVariablesScreen.loadError')} live>
              {describeError(variables.error)}
            </InlineAlert>
          ) : null}

          {remove.isError ? (
            <InlineAlert
              tone="danger"
              title={t('DocumentTemplateVariablesScreen.removeError')}
              live
            >
              {describeError(remove.error)}
            </InlineAlert>
          ) : null}

          {variables.isPending ? (
            <LoadingRegion label={t('DocumentTemplateVariablesScreen.loading')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!variables.isPending && !variables.isError && rows.length === 0 ? (
            <div className="tm-dx-empty">
              <p className="tm-dx-empty__title">
                {t('DocumentTemplateVariablesScreen.emptyTitle')}
              </p>
              <p className="tm-dx-empty__body">{t('DocumentTemplateVariablesScreen.emptyBody')}</p>
            </div>
          ) : null}

          {rows.length > 0 ? (
            <div
              className="tm-dx-table-card"
              // A scrollable region must be focusable or a keyboard cannot reach its overflow
              // columns (WCAG 2.2 2.1.1), matching the other screens' tables.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              role="region"
              aria-label={t('DocumentTemplateVariablesScreen.tableAria')}
            >
              <table className="tm-dx-table">
                <caption className="tm-visually-hidden">
                  {t('DocumentTemplateVariablesScreen.captionPrefix')} {rows.length}{' '}
                  {t('DocumentTemplateVariablesScreen.captionSuffix')}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t('DocumentTemplateVariablesScreen.thKey')}</th>
                    <th scope="col">{t('DocumentTemplateVariablesScreen.thLabel')}</th>
                    <th scope="col">{t('DocumentTemplateVariablesScreen.thType')}</th>
                    <th scope="col">{t('DocumentTemplateVariablesScreen.thRequired')}</th>
                    <th scope="col" className="tm-dx-table__end">
                      {t('DocumentTemplateVariablesScreen.thActions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((variable) => (
                    <tr key={variable.id}>
                      <th scope="row" className="tm-dx-table__title">
                        <span className="tm-dx-token">{variable.key}</span>
                      </th>
                      <td className="tm-dx-table__quiet">{variable.label}</td>
                      <td className="tm-dx-table__mono">{variable.type}</td>
                      <td>
                        {variable.required ? (
                          <span className="tm-dx-pill tm-dx-pill--proposed">
                            {t('DocumentTemplateVariablesScreen.requiredYes')}
                          </span>
                        ) : (
                          <span className="tm-dx-table__quiet">
                            {t('DocumentTemplateVariablesScreen.requiredNo')}
                          </span>
                        )}
                      </td>
                      <td className="tm-dx-table__end">
                        <span className="tm-dx-actions tm-dx-actions--end">
                          <Button
                            type="button"
                            tone="outline"
                            size="compact"
                            loading={remove.isPending && remove.variables === variable.id}
                            loadingLabel={t('DocumentTemplateVariablesScreen.removing')}
                            onClick={() => remove.mutate(variable.id)}
                          >
                            {t('DocumentTemplateVariablesScreen.remove')}
                          </Button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <aside
          className="tm-dx-split__side"
          aria-label={t('DocumentTemplateVariablesScreen.addAsideAria')}
        >
          <section className="tm-dx-card tm-dx-card--dashed" aria-labelledby="tm-var-new-heading">
            <h2 id="tm-var-new-heading" className="tm-dx-card__title">
              {t('DocumentTemplateVariablesScreen.newVariable')}
            </h2>
            <form
              className="tm-dx-form"
              noValidate
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                if (canAdd) add.mutate();
              }}
            >
              <Field
                label={t('DocumentTemplateVariablesScreen.keyLabel')}
                name="key"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                hint={t('DocumentTemplateVariablesScreen.keyHint')}
                required
              />
              <Field
                label={t('DocumentTemplateVariablesScreen.labelLabel')}
                name="label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                hint={t('DocumentTemplateVariablesScreen.labelHint')}
                required
              />
              <Select
                label={t('DocumentTemplateVariablesScreen.typeLabel')}
                name="type"
                value={type}
                onChange={(event) => setType(event.target.value as DocumentTemplateVariableType)}
                hint={t('DocumentTemplateVariablesScreen.typeHint')}
              >
                {TYPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </option>
                ))}
              </Select>
              <Checkbox
                label={t('DocumentTemplateVariablesScreen.requiredLabel')}
                name="required"
                checked={required}
                onChange={(event) => setRequired(event.target.checked)}
                hint={t('DocumentTemplateVariablesScreen.requiredHint')}
              />

              {add.isError ? (
                <InlineAlert
                  tone="danger"
                  title={t('DocumentTemplateVariablesScreen.addError')}
                  live
                >
                  {describeError(add.error)}
                </InlineAlert>
              ) : null}

              <Button
                type="submit"
                tone="ink"
                size="default"
                loading={add.isPending}
                loadingLabel={t('DocumentTemplateVariablesScreen.adding')}
                disabled={!canAdd}
              >
                {t('DocumentTemplateVariablesScreen.addVariable')}
              </Button>
            </form>
          </section>
        </aside>
      </div>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
