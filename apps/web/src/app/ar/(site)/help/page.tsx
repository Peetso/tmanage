import type { Metadata } from 'next';
import { HelpPage } from '../../../../components/website/pages/help/HelpPage';
import { HELP_COPY } from '../../../../content/help/help-copy';
import { TITLE_SUFFIX } from '../../../../lib/route-titles';

/** Row 55-16 — the Help centre in Arabic, `/ar/help`: the same page under the Arabic route locale. */
export const metadata: Metadata = {
  title: { absolute: `${HELP_COPY.ar.eyebrow}${TITLE_SUFFIX}` },
  description: HELP_COPY.ar.lede,
};

export default function ArabicHelpRoute() {
  return <HelpPage />;
}
