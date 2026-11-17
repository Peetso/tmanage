'use client';

import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/docs.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  applyDocumentTemplate,
  createDocumentTemplate,
  listDocumentTemplates,
} from '../../lib/api/document-templates';
import { listProjects } from '../../lib/api/projects';
import { useHydrated } from '../../lib/use-hydrated';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface DocumentTemplatesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **DOC-04 template gallery + ADM-06 document templates.**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Docs DOC-04 (template gallery/editor — purpose-led
 * previews) and §Administration ADM-06 (templates/workflows — document templates). This screen is
 * disjoint from the DOC-01 hub/read screens and the DOC-02/03 editor: it owns the org-scoped
 * templates a person creates once and reuses. It lists them with their purpose (the DOC-04
 * "purpose-led preview"), creates one, and applies one to a project — which creates a new document
 * seeded from the template body, from then on an ordinary document.
 *
 * ## What it does, and what it cannot
 *
 * - **Apply never edits the template.** The API reads the template and creates a fresh document; the
 *   template is unchanged and can be applied again. The screen links straight to the new document's
 *   editor so the applied copy can be worked on.
 * - **Variables/placeholders are not substituted.** DOC-04's advanced variable substitution and
 *   per-template permissions are deferred (NEXT-SCOPES-11); a template body is applied verbatim.
 * - **People are shown by id.** No endpoint resolves a member id to a display name here, the honesty
 *   the editor and workload screens apply to the same gap.
 */
export function DocumentTemplatesScreen({
  organizationSlug,
  organizationName,
  client,
}: DocumentTemplatesScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);

  const templates = useQuery({
    queryKey: ['document-templates', organizationSlug],
    queryFn: () => listDocumentTemplates(api, organizationSlug),
  });

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  // The standing `useHydrated` barrier (see PolicySimulationScreen): these controlled inputs ship
  // disabled in the server render and enable once React is live, so text typed before hydration
  // cannot sit in the DOM while state stays empty and leaves Create template disabled for good.
  const hydrated = useHydrated();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [body, setBody] = useState('');
  const [projectId, setProjectId] = useState('');
  const [applied, setApplied] = useState<{ id: string; title: string } | null>(null);

  const available = projects.data ?? [];
  const chosenProjectId = projectId !== '' ? projectId : (available[0]?.id ?? '');

  const create = useMutation({
    mutationFn: () =>
      createDocumentTemplate(api, organizationSlug, {
        name: name.trim(),
        purpose: purpose.trim(),
        body,
      }),
    onSuccess: async () => {
      setName('');
      setPurpose('');
      setBody('');
      await queryClient.invalidateQueries({
        queryKey: ['document-templates', organizationSlug],
      });
    },
  });

  const apply = useMutation({
    mutationFn: (templateId: string) =>
      applyDocumentTemplate(api, organizationSlug, templateId, { projectId: chosenProjectId }),
    onSuccess: (document) => {
      setApplied({ id: document.id, title: document.title });
    },
  });

  const rows = templates.data ?? [];
  const canCreate =
    name.trim() !== '' && purpose.trim() !== '' && body.trim() !== '' && !create.isPending;
  const canApply = chosenProjectId !== '';

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      eyebrow={t('DocumentTemplatesScreen.eyebrow')}
      title={t('DocumentTemplatesScreen.title')}
      actions={
        <Link className="tm-dx-back" href={`/${organizationSlug}/docs`}>
          <span className="tm-dx-back__orb" aria-hidden="true">
            ←
          </span>
          {t('DocumentTemplatesScreen.backToDocs')}
        </Link>
      }
    >
      <div className="tm-dx tm-dx-split">
        <section className="tm-dx-split__main" aria-labelledby="tm-tpl-gallery-heading">
          <div className="tm-dx-chips">
            <h2 id="tm-tpl-gallery-heading" className="tm-dx-caption">
              {t('DocumentTemplatesScreen.templateGallery')}
              {rows.length > 0 ? ` · ${rows.length}` : ''}
            </h2>
            {available.length > 0 ? (
              <div className="tm-dx-select tm-push-end">
                <label className="tm-dx-select__label" htmlFor="tm-tpl-project">
                  {t('DocumentTemplatesScreen.applyToProject')}
                </label>
                <select
                  id="tm-tpl-project"
                  className="tm-dx-select__control"
                  value={chosenProjectId}
                  onChange={(event) => setProjectId(event.target.value)}
                  aria-describedby="tm-tpl-project-hint"
                >
                  {available.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                <span id="tm-tpl-project-hint" className="tm-visually-hidden">
                  {t('DocumentTemplatesScreen.applyHint')}
                </span>
              </div>
            ) : null}
          </div>

          {applied ? (
            <InlineAlert tone="success" title={t('DocumentTemplatesScreen.createdTitle')} live>
              <p className="tm-prose">
                <Link href={`/${organizationSlug}/docs/${applied.id}/edit`}>
                  {t('DocumentTemplatesScreen.openPrefix')}&ldquo;{applied.title}&rdquo;
                </Link>{' '}
                {t('DocumentTemplatesScreen.editSuffix')}
              </p>
            </InlineAlert>
          ) : null}

          {templates.isError ? (
            <InlineAlert tone="danger" title={t('DocumentTemplatesScreen.loadError')} live>
              {describeError(templates.error)}
            </InlineAlert>
          ) : null}

          {apply.isError ? (
            <InlineAlert tone="danger" title={t('DocumentTemplatesScreen.applyError')} live>
              {describeError(apply.error)}
            </InlineAlert>
          ) : null}

          {templates.isPending ? (
            <LoadingRegion label={t('DocumentTemplatesScreen.loading')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!templates.isPending && !templates.isError && rows.length === 0 ? (
            <TeachingEmptyState
              title={t('DocumentTemplatesScreen.emptyTitle')}
              explanation={t('teachEmpty.docTemplatesBody')}
              action={
                canUse('doc.write') ? (
                  <Button
                    tone="lime"
                    size="accessible"
                    onClick={() => focusFirstField(firstStep.current)}
                  >
                    {t('teachEmpty.docTemplatesAction')}
                  </Button>
                ) : undefined
              }
            />
          ) : null}

          {rows.length > 0 ? (
            <div
              // A scrollable region must be focusable or a keyboard cannot reach its overflow
              // (WCAG 2.2 2.1.1), matching the other screens' tables.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              role="region"
              aria-label={t('DocumentTemplatesScreen.tableAria')}
            >
              {/* Explicit roles keep the table's semantics while it is drawn as DOC-04's stack of
                  purpose cards. */}
              {/* eslint-disable jsx-a11y/no-redundant-roles */}
              <table className="tm-dx-cards" role="table">
                <caption className="tm-visually-hidden">
                  {t('DocumentTemplatesScreen.captionPrefix')} {rows.length}{' '}
                  {t('DocumentTemplatesScreen.captionSuffix')}
                </caption>
                <thead role="rowgroup">
                  <tr role="row">
                    <th scope="col" role="columnheader">
                      {t('DocumentTemplatesScreen.thName')}
                    </th>
                    <th scope="col" role="columnheader">
                      {t('DocumentTemplatesScreen.thPurpose')}
                    </th>
                    <th scope="col" role="columnheader">
                      {t('DocumentTemplatesScreen.thActions')}
                    </th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {rows.map((template) => (
                    <tr key={template.id} role="row">
                      <th scope="row" role="rowheader" className="tm-dx-cards__title">
                        {template.name}
                      </th>
                      <td className="tm-dx-cards__body">{template.purpose}</td>
                      <td className="tm-dx-cards__actions">
                        <div>
                          <Link
                            className="tm-dx-link-capsule"
                            href={`/${organizationSlug}/docs/templates/${template.id}/variables`}
                          >
                            {t('DocumentTemplatesScreen.variables')}
                          </Link>
                          <Button
                            type="button"
                            tone="ink"
                            size="compact"
                            loading={apply.isPending && apply.variables === template.id}
                            loadingLabel={t('DocumentTemplatesScreen.applying')}
                            disabled={!canApply}
                            onClick={() => apply.mutate(template.id)}
                          >
                            {t('DocumentTemplatesScreen.apply')}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* eslint-enable jsx-a11y/no-redundant-roles */}
            </div>
          ) : null}

          {!projects.isPending && available.length === 0 ? (
            <InlineAlert tone="neutral" title={t('DocumentTemplatesScreen.noProjectsTitle')}>
              {t('DocumentTemplatesScreen.noProjectsBody')}
            </InlineAlert>
          ) : null}
        </section>

        <aside
          className="tm-dx-split__side"
          aria-label={t('DocumentTemplatesScreen.createAsideAria')}
        >
          <section className="tm-dx-card tm-dx-card--dashed" aria-labelledby="tm-tpl-new-heading">
            <h2 id="tm-tpl-new-heading" className="tm-dx-card__title">
              {t('DocumentTemplatesScreen.newTemplate')}
            </h2>
            <form
              ref={firstStep}
              className="tm-dx-form"
              noValidate
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                if (canCreate) create.mutate();
              }}
            >
              <fieldset className="tm-fieldset" disabled={!hydrated}>
                <Field
                  label={t('DocumentTemplatesScreen.nameLabel')}
                  name="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  hint={t('DocumentTemplatesScreen.nameHint')}
                  required
                />
                <Field
                  label={t('DocumentTemplatesScreen.purposeLabel')}
                  name="purpose"
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                  hint={t('DocumentTemplatesScreen.purposeHint')}
                  required
                />
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor="tm-tpl-body">
                    {t('DocumentTemplatesScreen.bodyLabel')}
                    <span className="tm-field__required" aria-hidden="true">
                      *
                    </span>
                  </label>
                  <textarea
                    id="tm-tpl-body"
                    name="body"
                    className="tm-field__control tm-field__control--multiline"
                    rows={6}
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    aria-describedby="tm-tpl-body-hint"
                    required
                  />
                  <span className="tm-field__hint" id="tm-tpl-body-hint">
                    {t('DocumentTemplatesScreen.bodyHint')}
                  </span>
                </div>

                {create.isError ? (
                  <InlineAlert tone="danger" title={t('DocumentTemplatesScreen.createError')} live>
                    {describeError(create.error)}
                  </InlineAlert>
                ) : null}

                <Button
                  type="submit"
                  tone="ink"
                  size="default"
                  loading={create.isPending}
                  loadingLabel={t('DocumentTemplatesScreen.creating')}
                  disabled={!canCreate}
                >
                  {t('DocumentTemplatesScreen.createTemplate')}
                </Button>
              </fieldset>
            </form>
          </section>

          <div className="tm-dx-info">
            <span className="tm-dx-info__orb" aria-hidden="true">
              i
            </span>
            <p>{t('DocumentTemplatesScreen.infoNote')}</p>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
