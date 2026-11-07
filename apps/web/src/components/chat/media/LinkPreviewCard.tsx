'use client';

import { useEffect, useState } from 'react';
import type { ApiClient } from '../../../lib/api/client';
import { browserApiClient } from '../../../lib/api/browser-client';
import { getLinkPreviewBatched, LINK_PREVIEW_RETRY_MS } from '../../../lib/api/link-previews';
import type { LinkPreview } from '../../../lib/api/link-previews';
import { useTOr } from '../../../lib/i18n/use-t-or';
import './media.css';

/** Pending reads before the card gives up until the next `link_preview.ready` frame. */
const MAX_PENDING_READS = 4;

export interface LinkPreviewCardProps {
  readonly organizationSlug: string;
  readonly conversationId: string;
  readonly messageId: string;
  /**
   * Bumped by the conversation when the hub sends `link_preview.ready` for this message (slice 6's
   * live feed); each change refetches. Without it the card retries on a 15 s backoff while pending.
   */
  readonly readySignal?: number;
  readonly client?: ApiClient;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return url;
  }
}

/**
 * **R7 link preview card** (Figma "Chat (R7)" › Link preview). What the worker unfurled for the
 * message's first link: site, title, description. The page's `og:image` is not loaded from the
 * linked site (the page's image policy admits no third-party hosts, and loading it would tell that
 * site who read the message); the card shows the site's initial instead. Nothing is drawn while
 * pending or when the unfurl failed — the link in the message body is still there.
 */
export function LinkPreviewCard({
  organizationSlug,
  conversationId,
  messageId,
  readySignal = 0,
  client,
}: LinkPreviewCardProps) {
  const [preview, setPreview] = useState<LinkPreview | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const api = client ?? browserApiClient();
    const read = (attempt: number) => {
      void getLinkPreviewBatched(api, organizationSlug, conversationId, messageId).then((found) => {
        if (!live) return;
        setPreview(found);
        if ((found === null || found.status === 'pending') && attempt < MAX_PENDING_READS) {
          timer = setTimeout(() => read(attempt + 1), LINK_PREVIEW_RETRY_MS * 2 ** attempt);
        }
      });
    };
    read(0);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, conversationId, messageId, organizationSlug, readySignal]);

  if (preview === null || preview.status !== 'ready') return null;
  return (
    <LinkPreviewCardView
      url={preview.url}
      siteName={preview.siteName}
      title={preview.title}
      description={preview.description}
    />
  );
}

export interface LinkPreviewCardViewProps {
  readonly url: string;
  readonly siteName: string | null;
  readonly title: string | null;
  readonly description: string | null;
}

/**
 * The card itself, with no fetching — reused by any surface that already holds an unfurl (the
 * work-item comment timeline). Draws nothing for a link that is not http(s).
 */
export function LinkPreviewCardView({
  url,
  siteName,
  title,
  description,
}: LinkPreviewCardViewProps) {
  const tOr = useTOr();
  if (!/^https?:\/\//iu.test(url)) return null;
  const site = siteName ?? hostOf(url);
  return (
    <a
      className="r7-link-card"
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      aria-label={tOr('ChatMedia.linkPreview', 'Link preview: {title}').replace(
        '{title}',
        title ?? site,
      )}
    >
      <span className="r7-link-card__thumb" aria-hidden="true">
        {[...site][0]?.toUpperCase() ?? '↗'}
      </span>
      <span className="r7-link-card__text">
        <span className="r7-link-card__site">{site}</span>
        {title === null ? null : <span className="r7-link-card__title">{title}</span>}
        {description === null ? null : (
          <span className="r7-link-card__description">{description}</span>
        )}
      </span>
    </a>
  );
}
