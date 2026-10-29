import type { Metadata } from 'next';
import { DownloadPage } from '../../../components/website/pages/download/DownloadPage';

/** The root layout's template adds ' · TManage'. */
export const metadata: Metadata = {
  title: 'Download',
};

/**
 * **PUB-03 · Download (51-10a).** The public `/download` page: the Windows installer with its
 * unsigned-beta notice and SHA256 checksum, the Mac "coming later" card and the phone home-screen steps.
 * Its Arabic twin is `/ar/download` (`app/ar/arabic-pages.ts`).
 */
export default function DownloadRoute() {
  return <DownloadPage />;
}
