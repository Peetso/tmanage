'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import { createProjectTemplate, listProjectTemplates } from '../../lib/api/project-templates';
import {
  NewProjectFromTemplateDialog,
  templateMeta,
} from '../projects/NewProjectFromTemplateDialog';
import { useTOr } from '../../lib/i18n/use-t-or';
import { TemplatePacksGallery } from '../projects/TemplatePacksGallery';
import '../projects/templates-milestones.css';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';

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
 * made from it should start with — and lists the organization's templates in creation order. A9: a
 * template is turned into a project through the "New project from a template" dialog (Figma
 * `fq6-new-from-template`). It reads `GET …/projects/templates` and
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
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const tOr = useTOr();
  const [picking, setPicking] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [objectives, setObjectives] = useState('');

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

  const rows = useMemo(() => templates.data ?? [], [templates.data]);
  const canSubmit = name.trim() !== '';

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
                className="tm-card tm-prj-card tm-stack"
                aria-labelledby="tm-project-templates-heading"
              >
                <div className="tm-a9-ms__head">
                  <h2 id="tm-project-templates-heading" className="tm-prj-eyebrow">
                    {t('ProjectTemplatesScreen.templates')}
                  </h2>
                  <Button
                    type="button"
                    tone="ink"
                    size="accessible"
                    onClick={() => setPicking(rows[0]?.id ?? '')}
                  >
                    {tOr('NewFromTemplate.open', 'New project from a template')}
                  </Button>
                </div>
                <ul className="tm-a9-choices">
                  {rows.map((template) => (
                    <li key={template.id}>
                      <button
                        type="button"
                        className="tm-a9-choice tm-a9-choice--button"
                        onClick={() => setPicking(template.id)}
                      >
                        <span className="tm-a9-choice__text">
                          <span className="tm-a9-choice__name">{template.name}</span>
                          <span className="tm-a9-choice__meta">{templateMeta(template, tOr)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <TemplatePacksGallery api={api} organizationSlug={organizationSlug} />
          </div>
        </div>
      </div>
      {picking !== null ? (
        <NewProjectFromTemplateDialog
          api={api}
          organizationSlug={organizationSlug}
          templates={rows}
          initialTemplateId={picking}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </AppShell>
  );
}
