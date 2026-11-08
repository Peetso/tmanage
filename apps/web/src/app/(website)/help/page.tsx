import type { Metadata } from 'next';
import { HelpPage } from '../../../components/website/pages/help/HelpPage';
import { HELP_COPY } from '../../../content/help/help-copy';

export const metadata: Metadata = {
  title: 'Help centre',
  description: HELP_COPY.en.lede,
};

/** Row 55-16 — the public Help centre, routed at `/help` (Arabic twin at `/ar/help`). */
export default function HelpRoute() {
  return <HelpPage />;
}
