'use client';

import { useId } from 'react';
import { Button, InlineAlert } from '@tmanage/ui';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { FormatIcon } from './format-icons';
import { extensionLabel, formatSize } from './format-stage-helpers';
import './format-stages.css';

/**
 * V-26 (`467:28224` EN, `467:28585` AR; phone `467:28523` / `467:28884`): a file the browser
 * cannot draw. A big file-type tile, a plain sentence why, "Download to view", and the facts.
 * Comments still work on the whole file (the rail says pins need a preview).
 *
 * The embedded-preview variant (`467:28372` / `467:28733`) is not this stage: the shell draws the
 * EPS's small preview with its ImageStage (pins allowed) and puts {@link EmbeddedPreviewNotice}
 * above the canvas and {@link EmbeddedPreviewChip} on it.
 */

export type UnsupportedReason = 'eps' | 'too_large' | 'zip_bomb' | 'office_failed' | 'other';

const BODY: Record<UnsupportedReason, MessageKey> = {
  eps: 'ViewerFormats.unsupported.bodyEps',
  too_large: 'ViewerFormats.unsupported.bodyTooLarge',
  zip_bomb: 'ViewerFormats.unsupported.bodyZipBomb',
  office_failed: 'ViewerFormats.unsupported.bodyOffice',
  other: 'ViewerFormats.unsupported.bodyOther',
};

const TYPE_NAMES: Readonly<Record<string, MessageKey>> = {
  'application/postscript': 'ViewerFormats.type.eps',
  'application/zip': 'ViewerFormats.type.zip',
  'image/vnd.adobe.photoshop': 'ViewerFormats.type.psd',
};

export interface UnsupportedStageProps {
  readonly fileName: string;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  /** "uploaded by Lina Samir" when the shell knows the uploader. */
  readonly uploadedBy?: string | null;
  readonly reason: UnsupportedReason;
  /** Saves the original (the shell's download door); absent while the file may not be served. */
  readonly onDownload?: () => void;
  /**
   * Peter, 2026-11-09 (viewer item 8) — the desktop-format card: a sentence of its own, the
   * file's type in words, the apps that open it, the name among the facts, and the preview
   * picture the file carries (shown in place of the type tile).
   */
  readonly bodyText?: string;
  readonly typeName?: string;
  readonly opensWith?: string;
  readonly showName?: boolean;
  readonly thumbnail?: { readonly src: string; readonly alt: string; readonly chip: string } | null;
}

/** Which reason a manifest's state stands for (EPS without a preview, size caps, …). */
export function unsupportedReasonFor(mimeType: string | null): UnsupportedReason {
  return mimeType === 'application/postscript' ? 'eps' : 'other';
}

export function UnsupportedStage({
  fileName,
  mimeType,
  sizeBytes,
  uploadedBy,
  reason,
  onDownload,
  bodyText,
  typeName,
  opensWith,
  showName = false,
  thumbnail = null,
}: UnsupportedStageProps) {
  const t = useT();
  const titleId = useId();
  const label = extensionLabel(fileName);
  const typeKey = mimeType ? TYPE_NAMES[mimeType] : undefined;
  const facts = [
    showName ? fileName : null,
    sizeBytes !== null && sizeBytes > 0 ? formatSize(sizeBytes) : null,
    typeName ?? (typeKey ? t(typeKey) : null),
    uploadedBy ? t('ViewerFormats.unsupported.uploadedBy').replace('{name}', uploadedBy) : null,
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <div className="tm-format-empty" role="group" aria-labelledby={titleId}>
      {thumbnail ? (
        <figure className="tm-format-empty__thumb">
          <img src={thumbnail.src} alt={thumbnail.alt} />
          <figcaption className="tm-format-chip">{thumbnail.chip}</figcaption>
        </figure>
      ) : (
        <span className="tm-format-empty__tile" aria-hidden="true">
          <FormatIcon name="file" className="tm-format-empty__glyph" />
          {label ? <span className="tm-format-empty__type">{label}</span> : null}
        </span>
      )}
      <h2 id={titleId} className="tm-format-empty__title">
        {t('ViewerFormats.unsupported.title')}
      </h2>
      <p className="tm-format-empty__body">{bodyText ?? t(BODY[reason])}</p>
      {opensWith ? <p className="tm-format-empty__apps">{opensWith}</p> : null}
      {onDownload ? (
        <Button tone="ink" onClick={onDownload}>
          <FormatIcon name="download" />
          <span>{t('ViewerFormats.unsupported.download')}</span>
        </Button>
      ) : null}
      {facts.length > 0 ? <p className="tm-format-empty__facts">{facts.join(' · ')}</p> : null}
    </div>
  );
}

/** The line above an EPS's embedded preview. */
export function EmbeddedPreviewNotice() {
  const t = useT();
  return (
    <InlineAlert className="tm-format-notice">{t('ViewerFormats.embedded.notice')}</InlineAlert>
  );
}

/** The chip on the canvas: "Low-resolution preview from the file". */
export function EmbeddedPreviewChip() {
  const t = useT();
  return (
    <span className="tm-format-chip tm-format-chip--stage">{t('ViewerFormats.embedded.chip')}</span>
  );
}
