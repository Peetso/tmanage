'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, InlineAlert } from '@tmanage/ui';
import { postProjectUpdate } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useHydrated } from '../../lib/use-hydrated';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/projects.css';

type Translate = ReturnType<typeof useT>;

export interface ProjectUpdateComposerProps {
  api: ApiClient;
  organizationSlug: string;
  projectId: string;
  /** The id of the composer's heading, so the screen's "Post update" button can move focus to it. */
  headingId: string;
}

/** `project_updates.title` is VARCHAR(300). */
const MAX_UPDATE_TITLE_LENGTH = 300;

/**
 * CL-03's internal compose surface (the client-portal updates timeline) — a manager posting an
 * update to the client's portal timeline. Opened from the project overview's "Post update".
 *
 * The write is behind `project.manage` (the API refuses anyone else), and it posts to the internal
 * `projects` path, never `/portal`. "Publish to the client now" is checked by default: an update
 * posted here is meant to reach the client, and leaving it unchecked keeps it a draft the client
 * cannot see (`published = false`). The publish/unpublish lifecycle is a later slice, so there is
 * no way to change that after posting yet — said in the hint rather than left implicit.
 *
 * On success the client-facing portal-updates query is invalidated so a portal tab already open
 * picks the new update up, and the form clears.
 */
export function ProjectUpdateComposer({
  api,
  organizationSlug,
  projectId,
  headingId,
}: ProjectUpdateComposerProps) {
  const t = useT();
  const queries = useQueryClient();
  // Controls ship disabled until React hydrates, so nothing typed into the server HTML is wiped.
  const hydrated = useHydrated();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [publishNow, setPublishNow] = useState(true);

  const post = useMutation({
    mutationFn: (vars: { title: string; body: string; published: boolean }) =>
      postProjectUpdate(api, organizationSlug, projectId, vars),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['portal-updates', organizationSlug, projectId] });
      setTitle('');
      setBody('');
      setPublishNow(true);
    },
  });

  const canPost = title.trim() !== '' && body.trim() !== '' && !post.isPending;

  return (
    <section className="tm-card tm-prj-card" aria-labelledby={headingId}>
      <h2 id={headingId} className="tm-section-head__title" tabIndex={-1}>
        {t('ProjectOverviewScreen.postAnUpdate')}
      </h2>

      <form
        className="tm-prj-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canPost)
            post.mutate({ title: title.trim(), body: body.trim(), published: publishNow });
        }}
      >
        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-project-update-title">
            {t('ProjectOverviewScreen.titleLabel')}
          </label>
          <input
            id="tm-project-update-title"
            className="tm-field__control"
            value={title}
            maxLength={MAX_UPDATE_TITLE_LENGTH}
            required
            disabled={!hydrated}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-project-update-body">
            {t('ProjectOverviewScreen.updateLabel')}
          </label>
          <textarea
            id="tm-project-update-body"
            className="tm-field__control"
            value={body}
            rows={4}
            required
            disabled={!hydrated}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>

        <Checkbox
          label={t('ProjectOverviewScreen.publishNow')}
          hint={t('ProjectOverviewScreen.updatePublishHint')}
          checked={publishNow}
          disabled={!hydrated}
          onChange={(event) => setPublishNow(event.target.checked)}
        />

        {post.isError ? (
          <InlineAlert tone="danger" title={t('ProjectOverviewScreen.couldNotPost')} live>
            {describe(post.error, t)}
          </InlineAlert>
        ) : null}
        {post.isSuccess ? (
          <InlineAlert tone="success" title={t('ProjectOverviewScreen.updatePosted')} live>
            {/* Report what was actually posted, not the live form state: the form (including
                `publishNow`) resets on success, so `post.variables` is what the last post carried. */}
            {post.variables.published
              ? t('ProjectOverviewScreen.updateLive')
              : t('ProjectOverviewScreen.draftSaved')}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            disabled={!canPost}
            loading={post.isPending}
            loadingLabel={t('ProjectOverviewScreen.posting')}
          >
            {t('ProjectOverviewScreen.postUpdate')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function describe(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('ProjectOverviewScreen.apiError');
  return t('ProjectOverviewScreen.genericError');
}
