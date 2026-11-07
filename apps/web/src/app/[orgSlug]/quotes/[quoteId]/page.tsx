'use client';

import { use } from 'react';
import { QuoteEditorScreen } from '../../../../components/screens/quotes/QuoteEditorScreen';
import { FIXTURE_ORGANIZATION_NAME } from '../../../../lib/fixtures';

/** **Quote** — edit and send a draft, or read a sent one (A12). */
export default function QuotePage({
  params,
}: {
  params: Promise<{ orgSlug: string; quoteId: string }>;
}) {
  const { orgSlug, quoteId } = use(params);

  return (
    <QuoteEditorScreen
      organizationSlug={orgSlug}
      organizationName={FIXTURE_ORGANIZATION_NAME}
      quoteId={quoteId}
    />
  );
}
