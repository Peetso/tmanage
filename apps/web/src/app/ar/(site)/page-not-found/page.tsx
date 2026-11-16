import type { Metadata } from 'next';
import {
  ARABIC_NOT_FOUND_METADATA,
  ArabicNotFound,
} from '../../../../components/website/ArabicNotFound';

/**
 * The Arabic 404, prerendered (NEXTUP). An unknown `/ar/...` path is answered with this page and
 * status 404 by `src/proxy.ts` (`publicNotFoundPage`), so the screen is in the HTML itself — a
 * `notFound()` thrown at request time would send an empty body. It renders inside the Arabic
 * website chrome like `(site)/not-found.tsx`, which still answers anything the proxy lets through.
 */
export const metadata: Metadata = ARABIC_NOT_FOUND_METADATA;

export default function ArabicNotFoundStaticPage() {
  return <ArabicNotFound />;
}
