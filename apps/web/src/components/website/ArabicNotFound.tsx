import type { Metadata } from 'next';
import { TITLE_SUFFIX } from '../../lib/route-titles';
import { ButtonLink } from './primitives';
import { WebSection } from './sections';
import './arabic-not-found.css';

/**
 * The Arabic 404 copy. The page exists only under `/ar`, so it is written in Arabic here rather
 * than carried as catalog keys with an English twin nobody would ever see.
 */
export const ARABIC_NOT_FOUND_COPY = {
  title: 'الصفحة غير موجودة',
  eyebrow: 'خطأ 404',
  heading: 'لم نجد هذه الصفحة',
  description: 'ربما نُقل الرابط أو كُتب بشكل خاطئ. ارجع إلى الصفحة الرئيسية أو تصفّح المصادر.',
  home: 'العودة إلى الصفحة الرئيسية',
  resources: 'تصفّح المصادر',
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
 * The not-found page of the Arabic website (Figma `429:22543`, the Arabic not-found frame): an
 * eyebrow, the heading, one line of help, and two ways back — the Arabic home (lime) and the
 * Arabic resources (outline). It renders inside the website chrome, so Web/Nav and Web/Footer
 * stay Arabic and the visitor is never dropped onto the English site.
 */
export function ArabicNotFound() {
  const copy = ARABIC_NOT_FOUND_COPY;
  return (
    <WebSection className="tm-web-not-found" aria-labelledby="tm-web-not-found-title">
      <p className="tm-web-not-found__eyebrow">{copy.eyebrow}</p>
      <h1 id="tm-web-not-found-title" className="tm-web-not-found__title">
        {copy.heading}
      </h1>
      <p className="tm-web-not-found__description">{copy.description}</p>
      <div className="tm-web-not-found__actions">
        <ButtonLink href="/ar" tone="lime" size="default">
          {copy.home}
        </ButtonLink>
        <ButtonLink href="/ar/resources" tone="outline" size="default">
          {copy.resources}
        </ButtonLink>
      </div>
    </WebSection>
  );
}
