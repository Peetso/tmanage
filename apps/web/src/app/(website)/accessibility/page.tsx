import type { Metadata } from 'next';
import { AccessibilityStatementPage } from '../../../components/website/pages/accessibility/AccessibilityStatementPage';

/**
 * **Accessibility** — the public `/accessibility` statement: what works today for keyboard,
 * screen-reader, contrast, motion and right-to-left users, the known gaps, and where to send
 * feedback.
 */
export const metadata: Metadata = {
  title: 'Accessibility',
  description:
    'How TManage works with a keyboard, screen readers, bigger text and Arabic, what we are still fixing, and how to tell us what is hard to use.',
};

export default function AccessibilityRoute() {
  return <AccessibilityStatementPage />;
}
