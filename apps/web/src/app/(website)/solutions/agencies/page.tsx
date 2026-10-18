import type { Metadata } from 'next';
import { SolutionsAgenciesPage } from '../../../../components/website/pages/solutions-agencies/SolutionsAgenciesPage';

/** Solutions · Agencies & studios (WEB-08) — the page lives in components/website/pages. */
export const metadata: Metadata = {
  title: 'TManage for agencies & studios',
  description:
    'Run every client project in one place — and give each client their own. Briefs, production, reviews and sign-off for many clients at once.',
};

export default function Page() {
  return <SolutionsAgenciesPage />;
}
