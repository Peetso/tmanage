import type { Metadata } from 'next';
import { SolutionsInhousePage } from '../../../../components/website/pages/solutions-inhouse/SolutionsInhousePage';

/** Solutions · In-house teams (SITE-SPEC "PAGE: Solutions · In-house teams"), at `/solutions/in-house`. */
export const metadata: Metadata = {
  title: 'TManage for in-house teams',
  description:
    'Marketing, product and operations teams take requests, commit dates and get sign-off without a ticket maze.',
};

export default function SolutionsInhouseRoute() {
  return <SolutionsInhousePage />;
}
