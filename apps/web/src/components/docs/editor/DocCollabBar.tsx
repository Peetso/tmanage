'use client';

import { useTOr } from '../../../lib/i18n/use-t-or';
import { initialsFor } from '../doc-markdown';
import type { CollabPeer, CollabStatus } from './use-doc-collab';

/**
 * Slice 53-10 — the top bar's live co-editing group (Figma 586:33239): the other editors' orbs,
 * each ringed in their member colour (the same colour as their cursor), the live count with you
 * included, and — when the editor is behind or offline — what it is doing about it.
 */
export function DocCollabBar({
  peers,
  status,
}: {
  readonly peers: readonly CollabPeer[];
  readonly status: CollabStatus;
}) {
  const tOr = useTOr();
  const count = peers.length + 1;
  return (
    <div className="tm-collab-bar">
      {peers.length > 0 ? (
        <ul
          className="tm-collab-bar__orbs"
          aria-label={tOr('DocCollab.membersAria', 'Editing now')}
        >
          {peers.map((peer) => (
            <li
              key={peer.userId}
              className={`tm-doced__orb tm-collab-bar__orb tm-collab--c${peer.colour % 6}`}
              title={peer.name}
            >
              <span aria-hidden="true">{initialsFor(peer.name)}</span>
              <span className="tm-collab-bar__sr">{peer.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <span className="tm-collab-bar__live">
        <span className="tm-collab-bar__dot" aria-hidden="true" />
        {tOr('DocCollab.editingLive', '{count} editing live').replace('{count}', String(count))}
      </span>
      {status !== 'live' ? (
        <span className="tm-collab-bar__status" role="status">
          {status === 'offline'
            ? tOr(
                'DocCollab.offline',
                'Connection lost. Your changes will send when you are back online.',
              )
            : tOr('DocCollab.catchingUp', 'Catching up with the latest changes…')}
        </span>
      ) : null}
    </div>
  );
}

/** Shown on the sheet above the title when the caller may read but not edit. */
export function DocViewOnlyBanner() {
  const tOr = useTOr();
  return (
    <div className="tm-collab-viewonly" role="note">
      <span className="tm-collab-viewonly__pill">{tOr('DocCollab.viewOnly', 'View only')}</span>
      <span>
        {tOr(
          'DocCollab.viewOnlyHint',
          'You can read this document. Ask an editor for edit access.',
        )}
      </span>
    </div>
  );
}
