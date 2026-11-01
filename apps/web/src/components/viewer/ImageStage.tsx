'use client';

import { useT } from '../../lib/i18n/use-t';

export interface ImageStageProps {
  /** Absolute URL of the preview (or of the original GIF / image when no preview is made). */
  readonly src: string;
  readonly alt: string;
  /** The image's size once known; the stage needs it to place pins before paint. */
  readonly onNaturalSize: (size: { readonly width: number; readonly height: number }) => void;
  readonly onError: () => void;
}

/**
 * V-03 — an image (PNG, JPEG, WebP, GIF, SVG's safe copy, HEIC/TIFF preview) filling the artwork
 * box. The bytes come from the API origin with the session cookie (`crossorigin="use-credentials"`);
 * an animated GIF is the original itself, so it keeps playing in its loop.
 */
export function ImageStage({ src, alt, onNaturalSize, onError }: ImageStageProps) {
  const t = useT();
  return (
    <img
      className="tm-viewer-art__media"
      src={src}
      alt={alt || t('Viewer.image.alt')}
      crossOrigin="use-credentials"
      draggable={false}
      decoding="async"
      onLoad={(event) => {
        const image = event.currentTarget;
        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
          onNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
        }
      }}
      onError={onError}
    />
  );
}
