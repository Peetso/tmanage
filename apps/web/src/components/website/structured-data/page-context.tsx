import type { MessageKey } from '../../../lib/i18n/t';
import {
  jsonLdGraph,
  jsonLdText,
  type JsonLd,
  type PageLanguage,
} from '../../../lib/structured-data';

/** What every structured-data chooser needs to know about the page it describes. */
export interface PageContext {
  /** The page's English path (`/ar/compare/x` → `/compare/x`). */
  readonly english: string;
  readonly language: PageLanguage;
  readonly t: (key: MessageKey) => string;
  /** The page's address in its own language, absolute. */
  readonly url: (englishPath: string) => string;
}

/** The props of a page family's structured data (help, library, compare and switch). */
export interface PageFamilyProps {
  readonly context: PageContext;
}

/**
 * The JSON-LD of a page as one data block, or nothing when it has none. A data block, not a
 * script: the browser never runs it, and the text is escaped so it cannot close the element.
 */
export function JsonLdScript({ items }: { readonly items: readonly JsonLd[] }) {
  const data = jsonLdGraph(items);
  if (data === undefined) return null;
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(data) }} />
  );
}
