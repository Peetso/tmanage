'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import { defineProjectTag, listProjectTags } from '../../lib/api/project-tags';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ProjectTagsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

/**
 * **x267 — project tags / labels.** (Projects / portfolio module.)
 *
 * The org-scoped project-tag taxonomy: define a reusable tag once, then tag projects with it to
 * filter the portfolio by tag. This screen owns the definitions — list them and define a new one;
 * both routes are gated on the server by `project.manage` (define) and `work.read` (list), so a
 * member without the capability sees the API's refusal rather than a blank page. Assigning a tag to a
 * specific project is the project detail's job, via the `assignProjectTag` / `listProjectTagAssignments`
 * helpers in `lib/api/project-tags`.
 */
export function ProjectTagsScreen({
  organizationSlug,
  organizationName,
  client,
}: ProjectTagsScreenProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
  const queryKey = ['project-tags', organizationSlug] as const;

  const [name, setName] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const tags = useQuery({
    queryKey,
    queryFn: () => listProjectTags(api, organizationSlug),
  });

  const define = useMutation({
    mutationFn: () => defineProjectTag(api, organizationSlug, name.trim()),
    onSuccess: async () => {
      setName('');
      setFailure(undefined);
      await queries.invalidateQueries({ queryKey });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const rows = tags.data ?? [];
  const canDefine = name.trim() !== '' && !define.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={t('ProjectTagsScreen.title')}
      description={t('ProjectTagsScreen.description')}
      eyebrow={t('ProjectTagsScreen.eyebrow')}
      topBar={<ProjectTabs organizationSlug={organizationSlug} />}
    >
      <div className="tm-prj tm-prj--sub">
        <div className="tm-prj__grid tm-prj__grid--aside">
          <div className="tm-prj__col tm-prj__col--aside">
            <section className="tm-card tm-prj-card" aria-labelledby="tm-project-tag-new-heading">
              <h2 id="tm-project-tag-new-heading" className="tm-prj-eyebrow">
                {t('ProjectTagsScreen.newTag')}
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
                  label={t('ProjectTagsScreen.nameLabel')}
                  name="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  hint={t('ProjectTagsScreen.nameHint')}
                  required
                />

                {failure ? (
                  <InlineAlert tone="danger" title={t('ProjectTagsScreen.defineFailed')} live>
                    {failure}
                  </InlineAlert>
                ) : null}

                <div className="tm-row">
                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    loading={define.isPending}
                    loadingLabel={t('ProjectTagsScreen.saving')}
                    disabled={!canDefine}
                  >
                    {t('ProjectTagsScreen.defineTag')}
                  </Button>
                </div>
              </form>
            </section>
          </div>
          <div className="tm-prj__col">
            <section className="tm-card tm-prj-card" aria-labelledby="tm-project-tag-list-heading">
              <h2 id="tm-project-tag-list-heading" className="tm-prj-eyebrow">
                {t('ProjectTagsScreen.tags')}
              </h2>
              {tags.isPending ? (
                <LoadingRegion label={t('ProjectTagsScreen.loading')}>
                  <Skeleton height="var(--row)" />
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : null}

              {tags.isError ? (
                <InlineAlert tone="danger" title={t('ProjectTagsScreen.loadFailed')} live>
                  {describe(tags.error)}
                </InlineAlert>
              ) : null}

              {tags.data ? (
                rows.length === 0 ? (
                  <p className="tm-prose">{t('ProjectTagsScreen.empty')}</p>
                ) : (
                  <ul
                    className="tm-row tm-row--wrap"
                    style={{ listStyle: 'none', padding: 0, margin: 0 }}
                  >
                    {rows.map((tag) => (
                      <li key={tag.id} className="tm-badge">
                        {tag.name}
                      </li>
                    ))}
                  </ul>
                )
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
