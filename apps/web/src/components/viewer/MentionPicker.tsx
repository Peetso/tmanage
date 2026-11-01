'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Avatar } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  searchReviewMentionCandidates,
  type ReviewAudience,
  type ReviewMentionCandidate,
} from '../../lib/api/review';
import { useT } from '../../lib/i18n/use-t';
import { useReviewDoor } from './review-door';

export interface MentionPickerProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly projectId: string;
  /** The text typed after "@". */
  readonly query: string;
  /** `client_visible` also lists the client's people; `internal` lists the team only. */
  readonly audience: ReviewAudience;
  /** True while the thread is still internal and may switch (a new thread): says what a client mention does. */
  readonly mentionSwitchesAudience: boolean;
  readonly activeIndex: number;
  readonly listId: string;
  readonly onResults: (candidates: readonly ReviewMentionCandidate[]) => void;
  readonly onPick: (candidate: ReviewMentionCandidate) => void;
}

/** The option element id for the candidate at `index` (for `aria-activedescendant`). */
export function mentionOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

/**
 * V-15 — the @mention picker over the composer. Team first, then the client's people; when client
 * people are listed it says that mentioning one makes the comment visible to the client. The
 * composer keeps focus and drives the active option with the arrow keys.
 */
export function MentionPicker({
  api,
  organizationSlug,
  projectId,
  query,
  audience,
  mentionSwitchesAudience,
  activeIndex,
  listId,
  onResults,
  onPick,
}: MentionPickerProps) {
  const t = useT();
  const { door } = useReviewDoor();
  const candidates = useQuery({
    queryKey: ['review-mention-candidates', door, organizationSlug, projectId, audience, query],
    queryFn: () =>
      searchReviewMentionCandidates(
        api,
        organizationSlug,
        projectId,
        { q: query, audience, limit: 8 },
        door,
      ),
    staleTime: 30_000,
  });

  const rows = candidates.data?.candidates ?? [];
  const team = rows.filter((row) => row.kind === 'internal');
  // A client names the team it is talking to (V-42); its own colleagues are not listed.
  const client = door === 'portal' ? [] : rows.filter((row) => row.kind === 'client');
  const ordered = [...team, ...client];

  useEffect(() => {
    onResults(ordered);
    // `ordered` is derived from the query's data; re-report only when that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.data]);

  function option(candidate: ReviewMentionCandidate, index: number) {
    return (
      <li
        key={candidate.userId}
        id={mentionOptionId(listId, index)}
        role="option"
        aria-selected={index === activeIndex}
        className="tm-viewer-mention__option"
        onMouseDown={(event) => {
          // Keep focus in the composer.
          event.preventDefault();
          onPick(candidate);
        }}
      >
        <Avatar
          name={candidate.displayName}
          audience={candidate.kind === 'client' ? 'client' : 'internal'}
          size="compact"
          decorative
        />
        <span className="tm-viewer-mention__name">{candidate.displayName}</span>
        <span className="tm-viewer-mention__role">
          {candidate.kind === 'client' ? t('Viewer.mention.client') : t('Viewer.mention.team')}
        </span>
      </li>
    );
  }

  return (
    <div className="tm-viewer-mention">
      {candidates.isPending ? (
        <p className="tm-viewer-mention__note">{t('Viewer.mention.searching')}</p>
      ) : ordered.length === 0 ? (
        <p className="tm-viewer-mention__note">{t('Viewer.mention.none')}</p>
      ) : (
        <ul id={listId} role="listbox" aria-label={t('Viewer.mention.label')}>
          {team.length > 0 ? (
            <li role="presentation" className="tm-viewer-mention__group">
              {t('Viewer.mention.groupTeam')}
            </li>
          ) : null}
          {team.map((candidate, index) => option(candidate, index))}
          {client.length > 0 ? (
            <li role="presentation" className="tm-viewer-mention__group">
              {t('Viewer.mention.groupClient')}
            </li>
          ) : null}
          {client.map((candidate, index) => option(candidate, team.length + index))}
        </ul>
      )}
      {client.length > 0 ? (
        <p className="tm-viewer-mention__note tm-viewer-mention__note--client">
          {mentionSwitchesAudience
            ? t('Viewer.mention.clientMakesVisible')
            : t('Viewer.mention.clientSees')}
        </p>
      ) : null}
    </div>
  );
}
