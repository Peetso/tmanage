'use client';

import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { convertQuote, type QuoteDocument } from './QuoteApi';

export interface QuoteConvertCardProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly quote: QuoteDocument;
}

/**
 * 52-08 — "Convert to project" on an ACCEPTED quote (Product page section 581:32859,
 * "R44 L1 · 52-08 quote convert"): one click makes a project whose work items are the quote's lines; afterwards the card
 * only opens that project. The API is idempotent, so a double click still makes one project.
 */
export function QuoteConvertCard({ api, organizationSlug, quote }: QuoteConvertCardProps) {
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const queryClient = useQueryClient();
  const convert = useMutation({
    mutationFn: () => convertQuote(api, organizationSlug, quote.id),
    onSuccess: (result) => {
      queryClient.setQueryData(['quote', organizationSlug, quote.id], {
        ...quote,
        convertedProjectId: result.projectId,
      });
      void queryClient.invalidateQueries({ queryKey: ['quotes', organizationSlug] });
    },
  });

  if (quote.status !== 'accepted') return null;
  const projectId = quote.convertedProjectId ?? convert.data?.projectId ?? null;

  return (
    <section className="tm-card tm-stack" aria-labelledby="tm-quote-convert-heading">
      <h2 id="tm-quote-convert-heading" className="tm-fin-card-title">
        {tOr('Quotes.convertTitle', 'Project')}
      </h2>
      {projectId === null ? (
        <>
          <p className="tm-fin-muted">
            {tOr(
              'Quotes.convertBody',
              'The client accepted this quote. Turn it into a project: each line becomes a work item.',
            )}
          </p>
          <Button
            type="button"
            tone="ink"
            size="compact"
            loading={convert.isPending}
            loadingLabel={tOr('Quotes.converting', 'Creating the project')}
            onClick={() => convert.mutate()}
          >
            {tOr('Quotes.convert', 'Convert to project')}
          </Button>
          {convert.isError ? (
            <InlineAlert
              tone="danger"
              title={tOr('Quotes.convertFailed', 'The project was not created')}
              live
            >
              {describe(convert.error)}
            </InlineAlert>
          ) : null}
        </>
      ) : (
        <>
          <p className="tm-fin-muted" role={convert.isSuccess ? 'status' : undefined}>
            {tOr(
              'Quotes.convertedBody',
              'This quote is now a project. Its lines are the project’s first work items.',
            )}
          </p>
          <Link
            className="tm-button tm-button--outline tm-button--default"
            href={`/${organizationSlug}/projects/${encodeURIComponent(projectId)}`}
          >
            {tOr('Quotes.openProject', 'Open project')}
          </Link>
        </>
      )}
    </section>
  );
}
