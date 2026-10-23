import type { Metadata } from 'next';
import { ConsultanciesPage } from '../../../../components/website/pages/solutions-consultancies/ConsultanciesPage';

export const metadata: Metadata = {
  title: 'Consultancies',
  description:
    'Engagements, findings, decisions and client sign-off in one auditable story. Make every recommendation traceable to a decision.',
};

/** Solutions · Consultancies — the route entry; the page lives in `components/website/pages`. */
export default function SolutionsConsultanciesRoute() {
  return <ConsultanciesPage />;
}
