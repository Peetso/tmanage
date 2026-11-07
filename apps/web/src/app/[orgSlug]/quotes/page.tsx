'use client';

import { use } from 'react';
import { QuoteListScreen } from '../../../components/screens/quotes/QuoteListScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../lib/fixtures';

/** **Quotes** — the quote list (A12). The API enforces `project.manage`. */
export default function QuotesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <QuoteListScreen organizationSlug={orgSlug} organizationName={FIXTURE_ORGANIZATION_NAME} />
  );
}
