'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, StateCapsule } from '@tmanage/ui';
import { editProjectUpdate, unpublishProjectUpdate } from '../../lib/api/portal';
import type { ManagedUpdate } from '../../lib/api/managed-updates';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { UnpublishUpdateDialog, formatUpdateDay, useA10T } from '../projects/UnpublishUpdateDialog';
import { useDescribeApiError } from '../../lib/api/describe-error';
import '../projects/update-card.css';

/** `project_updates.title` is VARCHAR(300). */
const MAX_UPDATE_TITLE_LENGTH = 300;

export interface UpdateLifecycleControlsProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly update: ManagedUpdate;
}

/**
 * **Published update card (A10, Figma fq6-published-update)** — and x201's edit/unpublish
 * lifecycle for one client update.
 *
 * The card: title, "Published <date> by <name>", a "Client can see" capsule, the body, the grey
 * "Linked: <milestone> · due <date>" block when a milestone is linked, then Unpublish (outline) and
 * Edit update (ink). Unpublish opens {@link UnpublishUpdateDialog} first — it warns when the
 * portal access log shows the client already opened the update. A draft shows no Unpublish.
 *
 * Both mutations invalidate the studio's updates list and the client-facing `portal-updates`
 * query, so the card re-reads as a draft and an open portal tab drops the update.
 */
export function UpdateLifecycleControls({
  api,
  organizationSlug,
  update,
}: UpdateLifecycleControlsProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const a10 = useA10T();
  const locale = useActiveLocale();
  const queries = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState(update.title);
  const [body, setBody] = useState(update.body);

  const invalidate = async () => {
    await Promise.all([
      queries.invalidateQueries({
        queryKey: ['managed-updates', organizationSlug, update.projectId],
      }),
      queries.invalidateQueries({
        queryKey: ['portal-updates', organizationSlug, update.projectId],
      }),
    ]);
  };

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
      setConfirming(false);
      void invalidate();
    },
  });

  const titleId = `tm-update-edit-title-${update.id}`;
  const bodyId = `tm-update-edit-body-${update.id}`;
  const headingId = `tm-update-card-${update.id}`;
  const canSave = title.trim() !== '' && body.trim() !== '' && !save.isPending;
  const posted = formatUpdateDay(update.createdAt, locale);

  if (editing) {
    return (
      <form
        noValidate
        className="tm-upd-card"
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

        <div className="tm-upd-actions">
          <Button
            type="button"
            tone="outline"
            size="accessible"
            disabled={save.isPending}
            onClick={() => setEditing(false)}
          >
            {t('UpdateLifecycleControls.cancel')}
          </Button>
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
        </div>
      </form>
    );
  }

  return (
    <article className="tm-upd-card" aria-labelledby={headingId}>
      <header className="tm-upd-card__head">
        <div className="tm-upd-card__heading">
          <h3 id={headingId} className="tm-upd-card__title">
            {update.title}
          </h3>
          <p className="tm-upd-card__meta">
            {a10(update.published ? 'UpdateCard.publishedBy' : 'UpdateCard.draftBy', {
              date: posted,
              name: update.authorName,
            })}
          </p>
        </div>
        {update.published ? (
          <StateCapsule state="client" className="tm-upd-card__pill">
            {a10('UpdateCard.clientCanSee')}
          </StateCapsule>
        ) : (
          <StateCapsule state="neutral" className="tm-upd-card__pill">
            {a10('UpdateCard.draft')}
          </StateCapsule>
        )}
      </header>

      <p className="tm-upd-card__body">{update.body}</p>

      {update.milestone ? (
        <p className="tm-upd-linked">
          <span className="tm-upd-linked__label">{a10('UpdateCard.linked')}</span>
          <span className="tm-upd-linked__value">
            {update.milestone.dueOn
              ? a10('UpdateCard.linkedDue', {
                  milestone: update.milestone.title,
                  date: formatUpdateDay(update.milestone.dueOn, locale, true),
                })
              : update.milestone.title}
          </span>
        </p>
      ) : null}

      <hr className="tm-upd-card__rule" />

      {unpublish.isSuccess && !update.published ? (
        <InlineAlert tone="success" title={t('UpdateLifecycleControls.unpublished')} live>
          {t('UpdateLifecycleControls.unpublishedBody')}
        </InlineAlert>
      ) : null}

      <div
        className="tm-upd-actions"
        role="group"
        aria-label={t('UpdateLifecycleControls.controls')}
      >
        {update.published ? (
          <Button
            type="button"
            tone="outline"
            size="accessible"
            onClick={() => setConfirming(true)}
          >
            {a10('UpdateCard.unpublish')}
          </Button>
        ) : null}
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
          {a10('UpdateCard.editUpdate')}
        </Button>
      </div>

      {confirming ? (
        <UnpublishUpdateDialog
          title={update.title}
          clientOpened={update.clientOpened}
          locale={locale}
          unpublishing={unpublish.isPending}
          error={unpublish.isError ? describe(unpublish.error) : null}
          onConfirm={() => unpublish.mutate()}
          onClose={() => {
            if (!unpublish.isPending) setConfirming(false);
          }}
        />
      ) : null}
    </article>
  );
}
