'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
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
      title="Project tags"
      description="Define reusable tags, then tag projects with them to filter the portfolio."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-project-tag-new-heading">
        <h2 id="tm-project-tag-new-heading" className="tm-eyebrow">
          New tag
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
            label="Name"
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint="A short handle, such as Retainer or At risk."
            required
          />

          {failure ? (
            <InlineAlert tone="danger" title="Could not define the tag" live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={define.isPending}
              loadingLabel="Saving"
              disabled={!canDefine}
            >
              Define tag
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-project-tag-list-heading">
        <h2 id="tm-project-tag-list-heading" className="tm-eyebrow">
          Tags
        </h2>
        {tags.isPending ? (
          <LoadingRegion label="Loading this studio’s project tags.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {tags.isError ? (
          <InlineAlert tone="danger" title="Could not load the tags" live>
            {describe(tags.error)}
          </InlineAlert>
        ) : null}

        {tags.data ? (
          rows.length === 0 ? (
            <p className="tm-prose">No project tags defined yet.</p>
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
    </AppShell>
  );
}
