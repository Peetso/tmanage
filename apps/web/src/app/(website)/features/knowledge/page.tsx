import type { Metadata } from 'next';
import { FeaturesKnowledgePage } from '../../../../components/website/pages/features-knowledge/FeaturesKnowledgePage';

export const metadata: Metadata = {
  title: 'Docs, decisions & approvals',
  description:
    'Docs, a decision register and governed deliverables — so you can always answer who agreed to what, and when.',
};

/** Features · Docs, decisions & approvals — SITE-SPEC "PAGE: Features · Docs, decisions & approvals". */
export default function Page() {
  return <FeaturesKnowledgePage />;
}
