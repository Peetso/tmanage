import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ARABIC_PAGES } from '../../arabic-pages';
import { ARABIC_NOT_FOUND_METADATA } from '../../../../components/website/ArabicNotFound';
import {
  arabicPublicMetadata,
  pathFromSegments,
  PUBLIC_LOCALIZED_PATHS,
  segmentsOf,
} from '../../../../lib/i18n/public-locale-routes';

/**
 * Every public page's Arabic twin (`/ar` … `/ar/status`), prerendered at build time from the
 * English route's own page component ({@link ARABIC_PAGES}). Only the listed paths exist: anything
 * else under `/ar` calls `notFound()` here, so the 404 is the Arabic one (`(site)/not-found.tsx`)
 * inside the Arabic chrome. `dynamicParams = false` would answer before this page runs, with the
 * root (English) not-found page instead.
 */
type Params = Promise<{ path?: string[] }>;

export function generateStaticParams(): { path: string[] }[] {
  return PUBLIC_LOCALIZED_PATHS.map((path) => ({ path: segmentsOf(path) }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const path = pathFromSegments((await params).path);
  return path === undefined ? ARABIC_NOT_FOUND_METADATA : arabicPublicMetadata(path);
}

export default async function ArabicPublicPage({ params }: { params: Params }) {
  const path = pathFromSegments((await params).path);
  if (path === undefined) notFound();
  const Page = ARABIC_PAGES[path];
  return <Page />;
}
