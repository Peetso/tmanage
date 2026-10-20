'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import { editProjectUpdate, unpublishProjectUpdate } from '../../lib/api/portal';
import type { PortalUpdate } from '../../lib/api/portal';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

/** `project_updates.title` is VARCHAR(300). */
const MAX_UPDATE_TITLE_LENGTH = 300;

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

export interface UpdateLifecycleControlsProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly update: PortalUpdate;
}

/**
 * x201 — edit and unpublish controls for one project update, the internal compose surface's
 * lifecycle half.
 *
 * A distinct component from x125's `UpdateComposer` (which only creates) and its timeline: this is
 * the studio's control over an update that already exists. Editing rewrites the title/body;
 * unpublishing removes the update from the client portal. Both are behind `project.manage` on the
 * API, so a client never renders — or reaches — these controls.
 *
 * On success both mutations invalidate the `portal-updates` query so the timeline re-reads the
 * changed (or now-hidden) row.
 */
export function UpdateLifecycleControls({
  api,
  organizationSlug,
  update,
}: UpdateLifecycleControlsProps) {
  const t = useT();
  const queries = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(update.title);
  const [body, setBody] = useState(update.body);

  const invalidate = () =>
    queries.invalidateQueries({
      queryKey: ['portal-updates', organizationSlug, update.projectId],
    });

  const save = useMutation({
    mutationFn: () =>
      editProjectUpdate(api, organizationSlug, update.projectId, update.id, {
        title: title.trim(),
        body: body.trim(),
      }),
    onSuccess: () => {
      void invalidate();
      setEditing(false);
    },
  });

  const unpublish = useMutation({
    mutationFn: () => unpublishProjectUpdate(api, organizationSlug, update.projectId, update.id),
    onSuccess: () => {
      void invalidate();
    },
  });

  const titleId = `tm-update-edit-title-${update.id}`;
  const bodyId = `tm-update-edit-body-${update.id}`;
  const canSave = title.trim() !== '' && body.trim() !== '' && !save.isPending;

  if (!editing) {
    return (
      <div className="tm-row" role="group" aria-label={t('UpdateLifecycleControls.controls')}>
        <Button
          type="button"
          tone="ink"
          size="accessible"
          onClick={() => {
            setTitle(update.title);
            setBody(update.body);
            setEditing(true);
          }}
        >
          {t('UpdateLifecycleControls.edit')}
        </Button>
        {update.published ? (
          <Button
            type="button"
            tone="outline"
            size="accessible"
            loading={unpublish.isPending}
            loadingLabel={t('UpdateLifecycleControls.unpublishing')}
            onClick={() => unpublish.mutate()}
          >
            {t('UpdateLifecycleControls.unpublish')}
          </Button>
        ) : null}
        {unpublish.isError ? (
          <InlineAlert tone="danger" title={t('UpdateLifecycleControls.unpublishError')} live>
            {describe(unpublish.error)}
          </InlineAlert>
        ) : null}
        {unpublish.isSuccess ? (
          <InlineAlert tone="success" title={t('UpdateLifecycleControls.unpublished')} live>
            {t('UpdateLifecycleControls.unpublishedBody')}
          </InlineAlert>
        ) : null}
      </div>
    );
  }

  return (
    <form
      className="tm-stack"
      aria-label={t('UpdateLifecycleControls.editForm')}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) save.mutate();
      }}
    >
      <div className="tm-field">
        <label className="tm-field__label" htmlFor={titleId}>
          {t('UpdateLifecycleControls.title')}
        </label>
        <input
          id={titleId}
          className="tm-field__control"
          value={title}
          maxLength={MAX_UPDATE_TITLE_LENGTH}
          required
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>

      <div className="tm-field">
        <label className="tm-field__label" htmlFor={bodyId}>
          {t('UpdateLifecycleControls.update')}
        </label>
        <textarea
          id={bodyId}
          className="tm-field__control"
          value={body}
          rows={4}
          required
          onChange={(event) => setBody(event.target.value)}
        />
      </div>

      {save.isError ? (
        <InlineAlert tone="danger" title={t('UpdateLifecycleControls.saveError')} live>
          {describe(save.error)}
        </InlineAlert>
      ) : null}

      <div className="tm-row">
        <Button
          type="submit"
          tone="ink"
          size="accessible"
          disabled={!canSave}
          loading={save.isPending}
          loadingLabel={t('UpdateLifecycleControls.saving')}
        >
          {t('UpdateLifecycleControls.save')}
        </Button>
        <Button
          type="button"
          tone="outline"
          size="accessible"
          disabled={save.isPending}
          onClick={() => setEditing(false)}
        >
          {t('UpdateLifecycleControls.cancel')}
        </Button>
      </div>
    </form>
  );
}
