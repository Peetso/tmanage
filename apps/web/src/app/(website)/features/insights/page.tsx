import type { Metadata } from 'next';
import { FeaturesInsightsPage } from '../../../../components/website/pages/features-insights/FeaturesInsightsPage';

/**
 * **Features · Insights & automations (WEB-06).** Explainable project health, the drafted
 * weekly Pulse, workload without people scores, automations with a dry run, and an assistant
 * that cites its sources. Every section lives in `components/website/pages/features-insights`.
 */
export const metadata: Metadata = {
  title: 'Insights & automations — TManage',
  description:
    'Every score drills into the work behind it. Every automation shows what it will do before it runs.',
};

export default function FeaturesInsightsRoute() {
  return <FeaturesInsightsPage />;
}
