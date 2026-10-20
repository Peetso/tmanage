'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import {
  createProjectTemplate,
  instantiateProjectTemplate,
  listProjectTemplates,
} from '../../lib/api/project-templates';
import type { ProjectTemplateView } from '../../lib/api/project-templates';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ProjectTemplatesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Reusable project templates (x234).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Projects: a studio's saved project shapes. This screen
 * defines a template — a name, an optional description, and the default objective titles a project
 * made from it should start with — and lists the organization's templates in creation order, then
 * instantiates a new project from one into a named workspace. It reads `GET …/projects/templates` and
 * writes `POST …/projects/templates` and `POST …/projects/templates/:id/instantiate`, all gated on the
 * server by `project.manage`.
 *
 * As on the sibling screens, **authorization is the API's**: a caller without the capability gets the
 * ordinary refusal, which `describeError()` turns into a sentence; the screen never guesses a
 * capability of its own and never renders blank on a refusal.
 */
export function ProjectTemplatesScreen({
  organizationSlug,
  organizationName,
  client,
}: ProjectTemplatesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [objectives, setObjectives] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');

  const templates = useQuery({
    queryKey: ['project-templates', organizationSlug],
    queryFn: () => listProjectTemplates(api, organizationSlug),
  });

  async function refetch() {
    await queryClient.invalidateQueries({ queryKey: ['project-templates', organizationSlug] });
  }

  const create = useMutation({
    mutationFn: () => {
      const defaultObjectives = objectives
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      return createProjectTemplate(api, organizationSlug, {
        name: name.trim(),
        ...(description.trim() === '' ? {} : { description: description.trim() }),
        ...(defaultObjectives.length === 0 ? {} : { defaultObjectives }),
      });
    },
    onSuccess: async () => {
      setName('');
      setDescription('');
      setObjectives('');
      await refetch();
    },
  });

  const instantiate = useMutation({
    mutationFn: (templateId: string) =>
      instantiateProjectTemplate(api, organizationSlug, templateId, {
        workspaceId: workspaceId.trim(),
      }),
  });

  const rows = useMemo(() => templates.data ?? [], [templates.data]);
  const canSubmit = name.trim() !== '';
  const canInstantiate = workspaceId.trim() !== '';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || create.isPending) return;
    create.mutate();
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={t('ProjectTemplatesScreen.title')}
      description={t('ProjectTemplatesScreen.description')}
      eyebrow={t('ProjectTemplatesScreen.eyebrow')}
      topBar={<ProjectTabs organizationSlug={organizationSlug} />}
    >
      <div className="tm-prj tm-prj--sub">
        <div className="tm-prj__grid tm-prj__grid--aside">
          <div className="tm-prj__col tm-prj__col--aside">
            <section className="tm-card tm-prj-card" aria-labelledby="tm-project-templates-author">
              <h2 id="tm-project-templates-author" className="tm-prj-eyebrow">
                {t('ProjectTemplatesScreen.defineATemplate')}
              </h2>
              <form className="tm-stack" onSubmit={onSubmit} noValidate>
                <fieldset
                  className="tm-fieldset tm-stack tm-stack--loose"
                  disabled={create.isPending}
                >
                  <Field
                    label={t('ProjectTemplatesScreen.nameLabel')}
                    name="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    hint={t('ProjectTemplatesScreen.nameHint')}
                    required
                  />

                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-project-template-description">
                      {t('ProjectTemplatesScreen.descriptionLabel')}
                    </label>
                    <textarea
                      id="tm-project-template-description"
                      name="description"
                      className="tm-field__control tm-field__control--multiline"
                      rows={3}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      aria-describedby="tm-project-template-description-hint"
                    />
                    <span className="tm-field__hint" id="tm-project-template-description-hint">
                      {t('ProjectTemplatesScreen.descriptionHint')}
                    </span>
                  </div>

                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-project-template-objectives">
                      {t('ProjectTemplatesScreen.defaultObjectives')}
                    </label>
                    <textarea
                      id="tm-project-template-objectives"
                      name="defaultObjectives"
                      className="tm-field__control tm-field__control--multiline"
                      rows={4}
                      value={objectives}
                      onChange={(event) => setObjectives(event.target.value)}
                      aria-describedby="tm-project-template-objectives-hint"
                    />
                    <span className="tm-field__hint" id="tm-project-template-objectives-hint">
                      {t('ProjectTemplatesScreen.objectivesHint')}
                    </span>
                  </div>
                </fieldset>

                {create.isError ? (
                  <InlineAlert tone="danger" title={t('ProjectTemplatesScreen.defineFailed')} live>
                    {describeError(create.error)}
                  </InlineAlert>
                ) : null}

                <div className="tm-row">
                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    loading={create.isPending}
                    loadingLabel={t('ProjectTemplatesScreen.saving')}
                    disabled={!canSubmit}
                  >
                    {t('ProjectTemplatesScreen.defineTemplate')}
                  </Button>
                </div>
              </form>
            </section>
          </div>
          <div className="tm-prj__col">
            {templates.isError ? (
              <InlineAlert tone="danger" title={t('ProjectTemplatesScreen.loadFailed')} live>
                {describeError(templates.error)}
              </InlineAlert>
            ) : null}

            {templates.isPending ? (
              <LoadingRegion label={t('ProjectTemplatesScreen.loading')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {!templates.isPending && !templates.isError && rows.length === 0 ? (
              <InlineAlert tone="neutral" title={t('ProjectTemplatesScreen.emptyTitle')}>
                {t('ProjectTemplatesScreen.emptyBody')}
              </InlineAlert>
            ) : null}

            {rows.length > 0 ? (
              <section
                className="tm-card tm-prj-card"
                aria-labelledby="tm-project-templates-heading"
              >
                <h2 id="tm-project-templates-heading" className="tm-prj-eyebrow">
                  {t('ProjectTemplatesScreen.templates')}
                </h2>

                <Field
                  label={t('ProjectTemplatesScreen.workspaceId')}
                  name="workspaceId"
                  value={workspaceId}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                  hint={t('ProjectTemplatesScreen.workspaceHint')}
                />

                {instantiate.isError ? (
                  <InlineAlert
                    tone="danger"
                    title={t('ProjectTemplatesScreen.instantiateFailed')}
                    live
                  >
                    {describeError(instantiate.error)}
                  </InlineAlert>
                ) : null}

                {instantiate.isSuccess ? (
                  <InlineAlert tone="success" title={t('ProjectTemplatesScreen.created')} live>
                    {t('ProjectTemplatesScreen.createdBodyPrefix')}
                    {instantiate.data.name}
                    {t('ProjectTemplatesScreen.createdBodySuffix')}
                  </InlineAlert>
                ) : null}

                <div
                  className="tm-table-scroll"
                  // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
                  // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                  tabIndex={0}
                  role="region"
                  aria-label={t('ProjectTemplatesScreen.tableLabel')}
                >
                  <table className="tm-table">
                    <caption className="tm-visually-hidden">
                      {t('ProjectTemplatesScreen.captionPrefix')}
                      {rows.length}
                      {t('ProjectTemplatesScreen.captionSuffix')}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('ProjectTemplatesScreen.colTemplate')}</th>
                        <th scope="col">{t('ProjectTemplatesScreen.defaultObjectives')}</th>
                        <th scope="col">{t('ProjectTemplatesScreen.colCreate')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((template) => (
                        <TemplateRow
                          key={template.id}
                          template={template}
                          onInstantiate={() => instantiate.mutate(template.id)}
                          busy={instantiate.isPending}
                          canInstantiate={canInstantiate}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function TemplateRow({
  template,
  onInstantiate,
  busy,
  canInstantiate,
}: {
  template: ProjectTemplateView;
  onInstantiate: () => void;
  busy: boolean;
  canInstantiate: boolean;
}) {
  const t = useT();
  return (
    <tr>
      <th scope="row" className="tm-table__title">
        {template.name}
        {template.description ? (
          <span className="tm-field__hint">{template.description}</span>
        ) : null}
      </th>
      <td>
        {template.defaultObjectives.length > 0 ? (
          <ul className="tm-list">
            {template.defaultObjectives.map((title, index) => (
              <li key={`${template.id}-${index}`}>{title}</li>
            ))}
          </ul>
        ) : (
          <span className="tm-field__hint">—</span>
        )}
      </td>
      <td>
        <Button
          type="button"
          tone="ink"
          size="accessible"
          onClick={onInstantiate}
          disabled={busy || !canInstantiate}
        >
          {t('ProjectTemplatesScreen.createProject')}
        </Button>
      </td>
    </tr>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
