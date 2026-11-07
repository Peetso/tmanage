'use client';

import { use } from 'react';
import { QuoteEditorScreen } from '../../../../components/screens/quotes/QuoteEditorScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/** **New quote** — a blank draft (A12); saving it moves to the quote's own page. */
export default function NewQuotePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = use(params);

  return (
    <QuoteEditorScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      quoteId={null}
    />
  );
}
