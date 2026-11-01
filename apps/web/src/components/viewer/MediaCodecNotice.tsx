'use client';

import { useId } from 'react';
import { Button } from '@tmanage/ui';
import type { PreviewMedia } from '../../lib/api/file-preview';
import { formatBytes } from '../../lib/api/uploads';
import { useT } from '../../lib/i18n/use-t';
import { MediaIcon } from './media-icons';
import { codecDisplayName, formatClock } from './media-time';

export interface MediaCodecNoticeProps {
  readonly kind: 'video' | 'audio';
  readonly media: PreviewMedia | null;
  readonly durationMs: number | null;
  readonly sizeBytes: number | null;
  /** Saves the original (the shell's download door). */
  readonly onDownload?: () => void;
  /** Staff who may upload a new version: "Upload an MP4 version". */
  readonly onUploadVersion?: () => void;
}

/**
 * V-20 codec notice (`462:23266`): the file is here and safe, but this browser cannot decode it
 * (an HEVC or ProRes `.mov`, AC-3 sound …). A card on the dark frame says so plainly, with the
 * facts, the download, and — for staff — the way out: upload an MP4 (H.264) version. Comments
 * still work; the stage's hint says they attach to the whole file.
 */
export function MediaCodecNotice({
  kind,
  media,
  durationMs,
  sizeBytes,
  onDownload,
  onUploadVersion,
}: MediaCodecNoticeProps) {
  const t = useT();
  const titleId = useId();
  const codec = codecDisplayName(
    media?.codecNotice === 'audio_codec' || kind === 'audio'
      ? media?.audioCodec
      : media?.videoCodec,
  );
  const facts = [
    kind === 'audio' ? media?.audioCodec : media?.videoCodec,
    media?.width && media?.height ? `${media.width}×${media.height}` : null,
    durationMs ? formatClock(durationMs) : null,
    sizeBytes !== null && sizeBytes > 0 ? formatBytes(sizeBytes) : null,
  ].filter((fact): fact is string => Boolean(fact));
  const body = codec
    ? t(kind === 'audio' ? 'ViewerMedia.codec.audioBody' : 'ViewerMedia.codec.videoBody').replace(
        '{codec}',
        codec,
      )
    : t(
        kind === 'audio'
          ? 'ViewerMedia.codec.audioBodyUnknown'
          : 'ViewerMedia.codec.videoBodyUnknown',
      );

  return (
    <div className="tm-media-codec" role="group" aria-labelledby={titleId}>
      <span className="tm-media-codec__orb" aria-hidden="true">
        <MediaIcon name="play" />
      </span>
      <h2 id={titleId} className="tm-media-codec__title">
        {t(kind === 'audio' ? 'ViewerMedia.codec.audioTitle' : 'ViewerMedia.codec.videoTitle')}
      </h2>
      <p className="tm-media-codec__body">{body}</p>
      {facts.length > 0 ? (
        <p className="tm-media-codec__facts" dir="ltr">
          {facts.join(' · ')}
        </p>
      ) : null}
      <div className="tm-media-codec__actions">
        {onDownload ? (
          <Button tone="ink" onClick={onDownload}>
            <MediaIcon name="download" />
            <span>{t('ViewerMedia.codec.download')}</span>
          </Button>
        ) : null}
        {onUploadVersion ? (
          <Button tone="outline" onClick={onUploadVersion}>
            <MediaIcon name="plus" />
            <span>
              {t(
                kind === 'audio'
                  ? 'ViewerMedia.codec.uploadAudio'
                  : 'ViewerMedia.codec.uploadVideo',
              )}
            </span>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
