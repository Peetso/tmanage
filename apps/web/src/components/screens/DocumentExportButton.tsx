'use client';

import { apiBaseUrl } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';

export interface DocumentExportButtonProps {
  organizationSlug: string;
  documentId: string;
  /**
   * The API origin the download link points at. Defaults to the browser client's
   * {@link apiBaseUrl}; a test passes a fixed value so the rendered href is deterministic and no
   * `NEXT_PUBLIC_*` needs to be set.
   */
  apiOrigin?: string;
}

/**
 * **DOC export (x131).** A download control for a document's current version as Markdown.
 *
 * ## Why a plain link, not a fetch
 *
 * The export endpoint (`GET .../documents/:id/export.md`) answers with the bytes and a
 * `Content-Disposition: attachment` header, so a top-level GET to it downloads rather than
 * navigates away. A link is the whole control: the browser sends the session cookie with the
 * navigation (SameSite=Lax covers a top-level GET), the API authorizes it behind `doc.read` exactly
 * as every other read, and no Markdown is ever parsed on the client. Routing it through the JSON
 * `ApiClient` would be wrong — that client reads every body as JSON and would discard the Markdown —
 * so the download deliberately does not go through it.
 *
 * The href is absolute (the API can live on another origin), built from {@link apiBaseUrl}. The
 * `download` attribute names the saved file for the same-origin case; cross-origin the browser
 * ignores it and honours the server's `Content-Disposition` filename, which is the same intent.
 */
export function DocumentExportButton({
  organizationSlug,
  documentId,
  apiOrigin,
}: DocumentExportButtonProps) {
  const origin = apiOrigin ?? apiBaseUrl();
  const href = `${origin}/v1/organizations/${encodeURIComponent(organizationSlug)}/documents/${encodeURIComponent(documentId)}/export.md`;
  const t = useT();

  return (
    <a className="tm-button tm-button--outline" href={href} download={`${documentId}.md`}>
      {t('DocumentExportButton.exportMarkdown')}
    </a>
  );
}
