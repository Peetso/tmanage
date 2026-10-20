'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  addMemberAdminNote,
  deleteMemberAdminNote,
  listMemberAdminNotes,
} from '../../lib/api/member-admin-notes';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';

export interface MemberNotesPanelProps {
  organizationSlug: string;
  membershipId: string;
  client?: ApiClient;
}

/**
 * **Admin private member notes (Administration module 18, x280).**
 *
 * The member-admin annotation surface `38-MODULE-MAP` §Administration defers: an org admin's private,
 * internal notes about a member, read newest-first, with an add form and a per-note delete. It renders
 * on the member-admin detail panel (`22-SCREEN` §Administration member detail) beside the member's own
 * read, so it is a plain labelled region rather than its own `AppShell` screen.
 *
 * ## Private by construction
 *
 * A note is an HR-style annotation, never shown to the member it is about. Every endpoint behind it is
 * `org.manage`, so this panel only ever renders for an administrator; there is no member-facing read
 * path that surfaces a note.
 *
 * ## Not-found is the read's quiet case
 *
 * The list is keyed by the member's membership id. The API resolves that id **tenant-scoped before the
 * `org.manage` authorize**, so an id in another tenant, and an id that does not exist, answer the same
 * 404. This panel shows that 404 as a plain "not available" note (the parent screen already renders the
 * member's own not-found state), and every other refusal as an error, so a transient outage is not
 * misread as "no notes".
 *
 * ## People are shown by id
 *
 * No endpoint resolves a membership id to a display name here, so an author is shown by the membership
 * id — the honesty `DocumentCommentsPanel` applies to the same gap.
 */
export function MemberNotesPanel({
  organizationSlug,
  membershipId,
  client,
}: MemberNotesPanelProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const queryKey = ['member-admin-notes', organizationSlug, membershipId];

  const notes = useQuery({
    queryKey,
    queryFn: () => listMemberAdminNotes(api, organizationSlug, membershipId),
  });

  const [draft, setDraft] = useState('');

  const add = useMutation({
    mutationFn: () => addMemberAdminNote(api, organizationSlug, membershipId, draft.trim()),
    onSuccess: async () => {
      setDraft('');
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const remove = useMutation({
    mutationFn: (noteId: string) =>
      deleteMemberAdminNote(api, organizationSlug, membershipId, noteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const notAvailable =
    notes.isError && notes.error instanceof ApiRequestError && notes.error.status === 404;

  const rows = notes.data ?? [];
  const canAdd = draft.trim() !== '';

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-member-notes">
      <h2 id="tm-member-notes" className="tm-eyebrow">
        {t('MemberNotesPanel.heading')}
      </h2>
      <p className="tm-field__hint">{t('MemberNotesPanel.hint')}</p>

      {notes.isPending ? (
        <LoadingRegion label={t('MemberNotesPanel.loadingLabel')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {notAvailable ? (
        <InlineAlert tone="neutral" title={t('MemberNotesPanel.unavailableTitle')} live>
          {t('MemberNotesPanel.unavailableBody')}
        </InlineAlert>
      ) : null}

      {notes.isError && !notAvailable ? (
        <InlineAlert tone="danger" title={t('MemberNotesPanel.loadErrorTitle')} live>
          {describeError(t, notes.error)}
        </InlineAlert>
      ) : null}

      {!notes.isPending && !notes.isError ? (
        rows.length > 0 ? (
          <ol className="tm-stack" aria-label={t('MemberNotesPanel.listAria')}>
            {rows.map((note) => (
              <li key={note.id} className="tm-stack">
                <p className="tm-prose">{note.body}</p>
                <div className="tm-row">
                  <p className="tm-field__hint">
                    {note.authorMembershipId} · {formatInstant(note.createdAt)}
                  </p>
                  <Button
                    type="button"
                    tone="destructive"
                    size="accessible"
                    loading={remove.isPending && remove.variables === note.id}
                    loadingLabel={t('MemberNotesPanel.deletingLabel')}
                    onClick={() => remove.mutate(note.id)}
                  >
                    {t('MemberNotesPanel.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="tm-prose">{t('MemberNotesPanel.emptyBody')}</p>
        )
      ) : null}

      {remove.isError ? (
        <InlineAlert tone="danger" title={t('MemberNotesPanel.deleteErrorTitle')} live>
          {describeError(t, remove.error)}
        </InlineAlert>
      ) : null}

      <form
        className="tm-stack"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (canAdd) add.mutate();
        }}
      >
        <div className="tm-field">
          <label className="tm-field__label" htmlFor="tm-member-note-body">
            {t('MemberNotesPanel.addLabel')}
          </label>
          <textarea
            id="tm-member-note-body"
            name="body"
            className="tm-field__control tm-field__control--multiline"
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>

        {add.isError ? (
          <InlineAlert tone="danger" title={t('MemberNotesPanel.addErrorTitle')} live>
            {describeError(t, add.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel={t('MemberNotesPanel.addingLabel')}
            disabled={!canAdd}
          >
            {t('MemberNotesPanel.addSubmit')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function describeError(t: (key: MessageKey) => string, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('MemberNotesPanel.errorNetwork');
  return t('MemberNotesPanel.errorGeneric');
}
