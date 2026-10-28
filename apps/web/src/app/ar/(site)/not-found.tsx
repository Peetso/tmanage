import type { Metadata } from 'next';
import {
  ARABIC_NOT_FOUND_METADATA,
  ArabicNotFound,
} from '../../../components/website/ArabicNotFound';

/**
 * The 404 of the Arabic website. An unknown `/ar/...` path and an unknown Arabic article both call
 * `notFound()` (`[[...path]]`, `resources/[slug]`) and land here, inside the Arabic website chrome
 * (`(site)/layout.tsx`) and the `ar-EG` route locale (`ar/layout.tsx`), so the page reads right to
 * left in Arabic and links back to `/ar`, not to the English site.
 */
export const metadata: Metadata = ARABIC_NOT_FOUND_METADATA;

export default function ArabicNotFoundPage() {
  return <ArabicNotFound />;
}
