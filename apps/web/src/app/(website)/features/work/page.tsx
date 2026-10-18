import type { Metadata } from 'next';
import { FeaturesWorkPage } from '../../../../components/website/pages/features-work/FeaturesWorkPage';

/**
 * Features · Work, requests & projects — `/features/work` (SITE-SPEC, Figma 03-features-work).
 * A thin route entry; the page lives in `components/website/pages/features-work`.
 */
export const metadata: Metadata = {
  title: 'Work, requests & projects',
  description:
    'Requests, tasks, milestones and projects in one model — viewed as a list, a board or a timeline without losing a thing.',
};

export default function FeaturesWorkRoute() {
  return <FeaturesWorkPage />;
}
