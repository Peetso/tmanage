'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ApiClient } from '../../../lib/api/client';
import { apiBaseUrl, browserApiClient } from '../../../lib/api/browser-client';
import { getMessageAttachmentsBatched } from '../../../lib/api/message-attachments';
import type { MessageAttachmentSummary } from '../../../lib/api/message-attachments';
import type { ReviewDoor } from '../../../lib/api/review';
import { formatBytes } from '../../../lib/api/uploads';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { FileViewer } from '../../viewer/FileViewer';
import { formatVoiceClock } from './VoiceNoteBubble';
import './media.css';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'document';

const KIND_BY_EXTENSION: Readonly<Record<string, AttachmentKind>> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  oga: 'audio',
  flac: 'audio',
};

/** What a bubble draws a file as, from its name (the attachment list carries no media type). */
export function attachmentKind(name: string): AttachmentKind {
  const dot = name.lastIndexOf('.');
  return KIND_BY_EXTENSION[dot === -1 ? '' : name.slice(dot + 1).toLowerCase()] ?? 'document';
}

/** The file's own bytes, inline, through the door the reader came in by. */
export function attachmentContentUrl(
  organizationSlug: string,
  fileAssetId: string,
  door: ReviewDoor = 'studio',
): string {
  const portal = door === 'portal' ? '/portal' : '';
  return (
    `${apiBaseUrl()}/v1/organizations/${encodeURIComponent(organizationSlug)}${portal}` +
    `/files/${encodeURIComponent(fileAssetId)}/content?inline=1`
  );
}

/** Whether the scan lets the bytes be shown (`clean`, or `not_scanned` under the B5 policy). */
function servable(attachment: MessageAttachmentSummary): boolean {
  return attachment.scanStatus === 'clean' || attachment.scanStatus === 'not_scanned';
}

export interface AttachmentBubblesProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly conversationId: string;
  readonly messageId: string;
  /** The message's attachments when the caller already has them; read (batched) otherwise. */
  readonly attachments?: readonly MessageAttachmentSummary[];
  /** File ids drawn elsewhere (a voice note's own file) and left out here. */
  readonly excludeFileIds?: readonly string[];
  readonly door?: ReviewDoor;
  readonly client?: ApiClient;
}

/**
 * **R7 media bubbles** (Figma "Chat (R7)" › Media). Photos and videos as a grid (1, 2, or 2×2 with
 * "+N"), every other file as a document card; any of them opens the R4 `FileViewer` in a modal.
 * Scan states follow the attachment list: "Checking…" while the scan runs, "Blocked by scan" when the
 * file is never served, a "Not scanned" mark when the studio's policy lets it through unscanned.
 */
export function AttachmentBubbles({
  organizationSlug,
  organizationName,
  conversationId,
  messageId,
  attachments,
  excludeFileIds = [],
  door = 'studio',
  client,
}: AttachmentBubblesProps) {
  const tOr = useTOr();
  const [loaded, setLoaded] = useState<readonly MessageAttachmentSummary[]>(attachments ?? []);
  const [openFileId, setOpenFileId] = useState<string | null>(null);

  useEffect(() => {
    if (attachments !== undefined) {
      setLoaded(attachments);
      return undefined;
    }
    let live = true;
    getMessageAttachmentsBatched(
      client ?? browserApiClient(),
      organizationSlug,
      conversationId,
      messageId,
    )
      .then((list) => live && setLoaded(list))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [attachments, client, conversationId, messageId, organizationSlug]);

  const shown = loaded.filter((attachment) => !excludeFileIds.includes(attachment.fileAssetId));
  const media = shown.filter((a) => {
    const kind = attachmentKind(a.name);
    return kind === 'image' || kind === 'video';
  });
  const documents = shown.filter((a) => !media.includes(a));
  if (shown.length === 0) return null;

  const scanLabel = (attachment: MessageAttachmentSummary): string | null =>
    attachment.scanStatus === 'being_checked'
      ? tOr('ChatMedia.checking', 'Checking…')
      : attachment.scanStatus === 'unavailable'
        ? tOr('ChatMedia.blocked', 'Blocked by scan')
        : null;

  const visible = media.slice(0, 4);
  return (
    <div className="r7-media">
      {visible.length > 0 ? (
        <div className="r7-media__grid" data-count={Math.min(media.length, 3)}>
          {visible.map((attachment, index) => {
            const more = index === 3 && media.length > 4 ? media.length - 4 : 0;
            const label = scanLabel(attachment);
            return (
              <button
                key={attachment.fileAssetId}
                type="button"
                className="r7-media__tile"
                aria-label={tOr('ChatMedia.open', 'Open {name}').replace('{name}', attachment.name)}
                disabled={attachment.scanStatus === 'unavailable'}
                onClick={() => setOpenFileId(attachment.fileAssetId)}
              >
                {label !== null ? (
                  <span className="r7-media__scan" data-state={attachment.scanStatus}>
                    {label}
                  </span>
                ) : attachmentKind(attachment.name) === 'image' ? (
                  <img
                    src={attachmentContentUrl(organizationSlug, attachment.fileAssetId, door)}
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <VideoTile
                    src={attachmentContentUrl(organizationSlug, attachment.fileAssetId, door)}
                  />
                )}
                {more > 0 ? <span className="r7-media__more">{`+${more}`}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {documents.map((attachment) => {
        const label = scanLabel(attachment);
        return (
          <button
            key={attachment.fileAssetId}
            type="button"
            className="r7-media__doc"
            disabled={!servable(attachment)}
            onClick={() => setOpenFileId(attachment.fileAssetId)}
          >
            <span className="r7-media__doc-icon" aria-hidden="true">
              {extensionOf(attachment.name)}
            </span>
            <span className="r7-media__doc-text">
              <span className="r7-media__doc-name">{attachment.name}</span>
              <span className="r7-media__doc-meta">
                {label ??
                  [
                    attachment.sizeBytes === null ? null : formatBytes(attachment.sizeBytes),
                    attachment.scanStatus === 'not_scanned'
                      ? tOr('ChatMedia.notScanned', 'Not scanned')
                      : null,
                  ]
                    .filter((part) => part !== null)
                    .join(' · ')}
              </span>
            </span>
            <span className="r7-media__doc-open">{tOr('ChatMedia.openShort', 'Open')}</span>
          </button>
        );
      })}
      {openFileId !== null ? (
        <MediaViewerModal
          onClose={() => setOpenFileId(null)}
          closeLabel={tOr('ChatMedia.close', 'Close')}
        >
          <FileViewer
            organizationSlug={organizationSlug}
            organizationName={organizationName}
            fileId={openFileId}
            door={door}
            {...(client === undefined ? {} : { client })}
            renderShell={(header, body) => (
              <div className="r7-media-viewer__frame">
                <div className="r7-media-viewer__head">
                  <span className="r7-media-viewer__title">{header.title}</span>
                  {header.actions}
                </div>
                {body}
              </div>
            )}
          />
        </MediaViewerModal>
      ) : null}
    </div>
  );
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? 'FILE' : name.slice(dot + 1, dot + 5).toUpperCase();
}

/** A video's first frame with its length in the corner. */
function VideoTile({ src }: { readonly src: string }) {
  const [durationMs, setDurationMs] = useState<number | null>(null);
  return (
    <>
      <video
        src={`${src}#t=0.1`}
        preload="metadata"
        muted
        playsInline
        onLoadedMetadata={(event) => {
          const seconds = event.currentTarget.duration;
          if (Number.isFinite(seconds)) setDurationMs(seconds * 1000);
        }}
      />
      <span className="r7-media__play" aria-hidden="true">
        ▶
      </span>
      {durationMs === null ? null : (
        <span className="r7-media__duration">{formatVoiceClock(durationMs)}</span>
      )}
    </>
  );
}

/** Keeps a viewer event from reaching the message bubble's own handlers through the React tree. */
const stopAtViewer = (event: SyntheticEvent): void => event.stopPropagation();

/**
 * A modal dialog over the conversation: Escape and the scrim close it, focus returns on close.
 *
 * B-N1: the dialog is portalled to `document.body`. Drawn inside the message bubble it inherited
 * the own bubble's inverted ink (`color: var(--paper-0)` on `--ink-950`), so spreadsheet cells, the
 * file name and the zoom label were white on the viewer's white paper. Outside the bubble it takes
 * the page's colours, and `.r7-media-viewer` resets its own ink, wrapping and font as well.
 */
function MediaViewerModal({
  children,
  onClose,
  closeLabel,
}: {
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly closeLabel: string;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);
  useEffect(() => {
    if (host === null) return undefined;
    const returnTo = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      returnTo?.focus?.();
    };
  }, [host, onClose]);
  if (host === null) return null;
  return createPortal(
    <div
      className="r7-media-viewer"
      data-testid="chat-media-viewer"
      onClick={stopAtViewer}
      onDoubleClick={stopAtViewer}
      onPointerDown={stopAtViewer}
      onMouseDown={stopAtViewer}
      onContextMenu={stopAtViewer}
      onKeyDown={stopAtViewer}
    >
      {/* The scrim closes the viewer on a click; keyboard users close it with Escape. */}
      <button
        type="button"
        className="r7-media-viewer__scrim"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        className="r7-media-viewer__dialog"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        ref={dialog}
      >
        <button
          type="button"
          className="r7-media-viewer__close"
          aria-label={closeLabel}
          onClick={onClose}
        >
          ×
        </button>
        {children}
      </div>
    </div>,
    host,
  );
}
