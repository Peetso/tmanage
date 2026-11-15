'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiBaseUrl } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import {
  filePreviewQueryKey,
  getFilePreviewManifest,
  previewThumb,
  type PreviewDoor,
} from '../../lib/api/file-preview';

/** Files whose own bytes a browser cannot draw, but whose preview job makes a thumbnail. */
const THUMBNAIL_ONLY = new Set(['psd', 'psb']);
function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** A Photoshop file (or another format whose picture only the preview job can draw). */
export function needsPreviewThumb(name: string): boolean {
  return THUMBNAIL_ONLY.has(extension(name));
}

export interface PreviewThumbProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly fileAssetId: string;
  readonly door?: PreviewDoor;
  /** Shown until the thumbnail is ready, and when there is none. */
  readonly fallback: ReactNode;
  readonly className?: string;
}

/**
 * FIX6 item 5 (live check B12): the small picture the preview job made for a file — a PSD in a
 * chat bubble or the Files list shows its artwork instead of a "PSD" badge. The manifest is asked
 * for only once the thumbnail scrolls into view, and through the same authorised preview route
 * as the viewer (the same react-query entry, so opening the file does not ask again). Only for
 * the formats that need it: reading a manifest counts as viewing the file in the audit log, so a
 * list of photos keeps its plain rows.
 */
export function PreviewThumb({
  api,
  organizationSlug,
  fileAssetId,
  door = 'studio',
  fallback,
  className,
}: PreviewThumbProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || seen) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);

  const manifest = useQuery({
    queryKey: filePreviewQueryKey(door, organizationSlug, fileAssetId),
    queryFn: () => getFilePreviewManifest(api, organizationSlug, fileAssetId, { door }),
    enabled: seen,
    staleTime: 60_000,
    retry: false,
  });
  const thumb = manifest.data ? previewThumb(manifest.data) : undefined;

  return (
    <span ref={ref} className={className}>
      {thumb && !broken ? (
        <img
          src={`${apiBaseUrl()}${thumb.url}`}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        fallback
      )}
    </span>
  );
}
