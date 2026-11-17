import type { Metadata } from 'next';
import { TITLE_SUFFIX } from '../../lib/route-titles';
import { NotFoundState } from '../state/StateScreens';
import './arabic-not-found.css';

/** The Arabic 404's tab title (the page's text comes from the shared `NotFoundState`). */
export const ARABIC_NOT_FOUND_COPY = {
  title: 'الصفحة غير موجودة',
} as const;

/**
 * The Arabic 404's head. `notFound()` thrown from a page keeps that page's `generateMetadata`
 * result, not the boundary's `metadata`, so the Arabic pages return this for a path they do not
 * have; `(site)/not-found.tsx` exports it too.
 */
export const ARABIC_NOT_FOUND_METADATA: Metadata = {
  title: { absolute: `${ARABIC_NOT_FOUND_COPY.title}${TITLE_SUFFIX}` },
  robots: { index: false, follow: false },
};

/**
 * The not-found page of the Arabic website, inside the website chrome (Web/Nav and Web/Footer
 * stay Arabic). CONFIRMPOLISH 5: the same `NotFoundState` as every other 404 (Figma 640:35585,
 * frames 01/02): centred, the glyph, the small "غير موجود" label, the heading, one line of help,
 * and two ways on, the Arabic home and the Arabic sign-in. Its words come from the `ar` catalog
 * through the route locale.
 */
export function ArabicNotFound() {
  return (
    <div className="tm-web-not-found">
      <NotFoundState homeHref="/ar" signInHref="/ar/sign-in" />
    </div>
  );
}
