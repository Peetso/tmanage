'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, StateCapsule, TextButton } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { listMeetingNoteDrafts, reviewMeetingNoteDraft } from '../../lib/api/meetings';
import type { MeetingNoteDraftReview, MeetingNoteDraftView } from '../../lib/api/meetings';
import { ApiRequestError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/meeting-note-drafts.css';

export interface MeetingNoteDraftsPanelProps {
  api: ApiClient;
  organizationSlug: string;
  meetingId: string;
}

/**
 * **53-13 — drafts from the member's own AI, reviewed before they are saved.**
 *
 * TManage pays for no model: the member's own assistant, connected over the TManage MCP
 * connector, submits a draft note for this meeting. It waits here with its provenance (which
 * assistant, when) and is not part of the meeting's record until a person edits it if needed and
 * chooses Save, or Discard. Nothing renders when there are no drafts. Figma: Product page,
 * section "R40 L2-53-13-ai-notes" (566:32285).
 */
export function MeetingNoteDraftsPanel({
  api,
  organizationSlug,
  meetingId,
}: MeetingNoteDraftsPanelProps) {
  const t = useT();
  const drafts = useQuery({
    queryKey: ['meeting-note-drafts', organizationSlug, meetingId],
    queryFn: () => listMeetingNoteDrafts(api, organizationSlug, meetingId),
  });
  const rows = drafts.data?.drafts ?? [];
  if (rows.length === 0) return null;

  return (
    <section className="tm-cal-card tm-note-drafts" aria-label={t('MeetingNoteDrafts.regionAria')}>
      <p className="tm-cal-eyebrow">
        {t('MeetingNoteDrafts.heading')} · {rows.length}
      </p>
      <p className="tm-note-drafts__hint">{t('MeetingNoteDrafts.hint')}</p>
      {rows.map((draft) => (
        <DraftCard
          key={draft.id}
          api={api}
          organizationSlug={organizationSlug}
          meetingId={meetingId}
          draft={draft}
        />
      ))}
    </section>
  );
}

function DraftCard({
  api,
  organizationSlug,
  meetingId,
  draft,
}: MeetingNoteDraftsPanelProps & { draft: MeetingNoteDraftView }) {
  const t = useT();
  const queries = useQueryClient();
  const bodyId = useId();
  const [kind, setKind] = useState<MeetingNoteDraftView['kind']>(draft.kind);
  const [body, setBody] = useState(draft.body);

  const review = useMutation({
    mutationFn: (input: MeetingNoteDraftReview) =>
      reviewMeetingNoteDraft(api, organizationSlug, meetingId, draft.id, input),
    onSettled: async () => {
      await Promise.all([
        queries.invalidateQueries({
          queryKey: ['meeting-note-drafts', organizationSlug, meetingId],
        }),
        queries.invalidateQueries({ queryKey: ['meeting-notes', organizationSlug, meetingId] }),
      ]);
    },
  });

  const trimmed = body.trim();
  const busy = review.isPending;

  return (
    <article className="tm-note-draft" aria-labelledby={`${bodyId}-prov`}>
      <div className="tm-note-draft__top">
        <StateCapsule state="waiting">{t('MeetingNoteDrafts.draft')}</StateCapsule>
        <span id={`${bodyId}-prov`} className="tm-note-draft__prov">
          {draft.assistantName} · {t('MeetingNoteDrafts.viaMcp')} ·{' '}
          <time dateTime={draft.submittedAt}>{formatInstant(draft.submittedAt)}</time>
        </span>
      </div>

      <div
        className="tm-note-draft__kinds"
        role="group"
        aria-label={t('MeetingNoteDrafts.kindAria')}
      >
        {(['note', 'decision'] as const).map((value) => (
          <Button
            key={value}
            tone={kind === value ? 'ink' : 'outline'}
            aria-pressed={kind === value}
            onClick={() => setKind(value)}
          >
            {value === 'decision'
              ? t('MeetingNotesScreen.kindDecision')
              : t('MeetingNotesScreen.kindNote')}
          </Button>
        ))}
      </div>

      <div className="tm-field">
        <label className="tm-field__label" htmlFor={bodyId}>
          {t('MeetingNoteDrafts.bodyLabel')}
        </label>
        <textarea
          id={bodyId}
          className="tm-field__control tm-note-draft__body"
          rows={4}
          maxLength={8000}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>

      {review.isError ? (
        <InlineAlert tone="danger" title={t('MeetingNoteDrafts.errorTitle')} live>
          {review.error instanceof ApiRequestError
            ? review.error.message
            : t('MeetingNotesScreen.errorGeneric')}
        </InlineAlert>
      ) : null}

      <div className="tm-note-draft__actions">
        <Button
          tone="ink"
          loading={busy && review.variables?.decision === 'save'}
          disabled={trimmed === '' || busy}
          onClick={() => review.mutate({ decision: 'save', kind, body: trimmed })}
        >
          {t('MeetingNoteDrafts.save')}
        </Button>
        <TextButton disabled={busy} onClick={() => review.mutate({ decision: 'discard' })}>
          {t('MeetingNoteDrafts.discard')}
        </TextButton>
      </div>
    </article>
  );
}
