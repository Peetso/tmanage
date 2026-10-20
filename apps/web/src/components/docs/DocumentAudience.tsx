'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { getDocumentSharing, setDocumentAudience } from '../../lib/api/documents';
import type { DocumentAudience, DocumentPerson } from '../../lib/api/documents';
import { ApiRequestError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

/**
 * Docs audience pieces from `TManage Screens - Docs and Decisions.dc.html`: the hub's AUDIENCE cell
 * ("◎ Client · 2" / "■ Internal"), the top bar's audience capsule, the overlapping collaborator faces
 * and the Publish button. All values come from the API; nothing here invents a person or a count.
 */

/** Two initials for a face: first and last word, or the first two letters of a single word. */
export function initialsOf(displayName: string): string {
  const words = displayName.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = [...(words[0] ?? '')];
  if (words.length === 1) return first.slice(0, 2).join('').toUpperCase();
  const last = [...(words[words.length - 1] ?? '')];
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

/** "Client · 2" or "Internal" — the hub's audience label. */
export function audienceLabel(audience: DocumentAudience, clientCount: number): string {
  return audience === 'client' ? `Client · ${clientCount}` : 'Internal';
}

/** The hub's AUDIENCE cell. */
export function AudienceBadge({
  audience,
  clientCount,
}: {
  audience: DocumentAudience;
  clientCount: number;
}) {
  return (
    <span className="tm-dx-audience" data-audience={audience}>
      <span className="tm-dx-audience__orb" aria-hidden="true">
        {audience === 'client' ? '◎' : '■'}
      </span>
      {audienceLabel(audience, clientCount)}
    </span>
  );
}

/** Overlapping faces; the last one (most recent contributor) carries the accent ring. */
export function CollaboratorFaces({ people }: { people: readonly DocumentPerson[] }) {
  if (people.length === 0) return null;
  const shown = people.slice(0, 4);
  return (
    <ul
      className="tm-dx-faces"
      aria-label={`Collaborators: ${people.map((person) => person.displayName).join(', ')}`}
    >
      {shown.map((person, index) => (
        <li
          key={person.userId}
          className="tm-dx-faces__face"
          title={person.displayName}
          {...(index === shown.length - 1 && shown.length > 1 ? { 'data-latest': 'true' } : {})}
        >
          <span aria-hidden="true">{initialsOf(person.displayName)}</span>
        </li>
      ))}
      {people.length > shown.length ? (
        <li className="tm-dx-faces__face tm-dx-faces__more">
          <span aria-hidden="true">+{people.length - shown.length}</span>
        </li>
      ) : null}
    </ul>
  );
}

export interface DocumentPublishBarProps {
  organizationSlug: string;
  documentId: string;
  client?: ApiClient;
}

/**
 * DOC-02's top-bar cluster: the audience capsule, the collaborator faces and Publish. Publish is
 * shown only to a caller the API says may publish (`canPublish`, the `deliverable.publish` relation
 * on the document's project); the server re-checks it on every request either way.
 */
export function DocumentPublishBar({
  organizationSlug,
  documentId,
  client,
}: DocumentPublishBarProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const key = ['document-sharing', organizationSlug, documentId];

  const sharing = useQuery({
    queryKey: key,
    queryFn: () => getDocumentSharing(api, organizationSlug, documentId),
  });

  const change = useMutation({
    mutationFn: (audience: DocumentAudience) =>
      setDocumentAudience(api, organizationSlug, documentId, audience),
    onSuccess: async (next) => {
      queryClient.setQueryData(key, next);
      await queryClient.invalidateQueries({ queryKey: ['recent-documents', organizationSlug] });
    },
  });

  const data = sharing.data;
  // An answer without the sharing shape (an older API build) draws nothing rather than guessing.
  if (!data || !Array.isArray(data.collaborators)) return null;
  const published = data.audience === 'client';
  const count = data.clientAudienceCount;
  // COL-14: plain words, and no "client" wording while the document is still internal. Published:
  // say who can see it now; unpublished: say it is internal to the team.
  const capsule = published
    ? `Shared with clients · ${count} ${count === 1 ? 'person' : 'people'}`
    : 'Your team only — not shared yet';

  return (
    <div className="tm-dx-share">
      <span className="tm-dx-share__audience" data-audience={data.audience}>
        <span className="tm-dx-share__orb" aria-hidden="true">
          {published ? '◎' : '■'}
        </span>
        {capsule}
      </span>
      <CollaboratorFaces people={data.collaborators} />
      {data.canPublish ? (
        <button
          type="button"
          className={`tm-button ${published ? 'tm-button--outline' : 'tm-button--ink'} tm-button--default`}
          aria-busy={change.isPending}
          disabled={change.isPending}
          onClick={() => change.mutate(published ? 'internal' : 'client')}
        >
          {published ? 'Unpublish' : 'Publish'}
        </button>
      ) : null}
      {change.isError ? (
        <InlineAlert tone="danger" title="Could not change who sees this document" live>
          {change.error instanceof ApiRequestError
            ? change.error.message
            : 'Something went wrong. Try again.'}
        </InlineAlert>
      ) : null}
    </div>
  );
}
