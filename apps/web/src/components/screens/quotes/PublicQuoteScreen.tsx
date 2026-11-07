'use client';

import { useId, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { decideQuote, openQuoteLink, requestQuoteCode } from './QuoteApi';
import '../../../styles/screens/finance-ledger.css';
import '../../../styles/screens/quotes.css';

export interface PublicQuoteScreenProps {
  readonly token: string;
  readonly client?: ApiClient;
}

type Decided = { readonly decision: string };

/**
 * **Quote for the client** (`/q/<token>`, A12) — drawn as the R31 L04 Figma frame
 * "Quote · Client accept view". No account: the page opens the 56-07 quote link, shows the frozen
 * lines and totals, and takes the client's accept or decline. Accepting always needs the code the
 * API mails to the address the quote was sent to; the API re-checks the content hash, so a quote
 * edited after sending can no longer be accepted through an old link.
 */
export function PublicQuoteScreen({ token, client }: PublicQuoteScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const { money, day } = useDisplayFormatters();
  const commentId = useId();

  const view = useQuery({
    queryKey: ['quote-link', token],
    queryFn: () => openQuoteLink(api, token),
    retry: false,
  });
  const [code, setCode] = useState('');
  const [comment, setComment] = useState('');
  const [decided, setDecided] = useState<Decided | null>(null);

  const askCode = useMutation({ mutationFn: () => requestQuoteCode(api, token) });
  const decide = useMutation({
    mutationFn: (decision: 'accept' | 'decline') =>
      decideQuote(api, token, {
        decision,
        ...(code.trim() === '' ? {} : { code: code.trim() }),
        ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
      }),
    onSuccess: (result) => setDecided({ decision: result.decision }),
  });

  const footer = (
    <p className="tm-quote-public__footer">{tOr('PublicForm.poweredBy', 'Powered by TManage')}</p>
  );

  const shell = (body: ReactNode) => (
    <main className="tm-quote-public">
      {body}
      {footer}
    </main>
  );

  if (view.isPending) {
    return shell(
      <div className="tm-card tm-quote-public__card">
        <LoadingRegion label={tOr('QuoteLink.loading', 'Loading the quote')}>
          <Skeleton height="32px" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      </div>,
    );
  }

  const data = view.data;
  const decision = decided?.decision ?? (data?.state === 'decided' ? data.decision : null);

  if (decision !== null) {
    const accepted = decision === 'accept';
    return shell(
      <div className="tm-card tm-quote-public__card tm-stack">
        <StateCapsule state={accepted ? 'done' : 'blocked'}>
          {accepted
            ? tOr('Quotes.statusAccepted', 'Accepted')
            : tOr('Quotes.statusDeclined', 'Declined')}
        </StateCapsule>
        <p>
          {accepted
            ? tOr('QuoteLink.acceptedBody', 'Thank you. Your acceptance has been recorded.')
            : tOr('QuoteLink.declinedBody', 'Thank you. Your answer has been recorded.')}
        </p>
      </div>,
    );
  }

  if (view.isError || !data || data.state !== 'active') {
    return shell(
      <div className="tm-card tm-quote-public__card tm-stack">
        <h1 className="tm-quote-public__title">
          {tOr('QuoteLink.unavailableTitle', 'This quote is no longer open')}
        </h1>
        <p className="tm-fin-muted">
          {tOr(
            'QuoteLink.unavailableBody',
            'The link has expired, was replaced, or the quote changed. Ask the sender for a new link.',
          )}
        </p>
      </div>,
    );
  }

  const quote = data.projection;
  const acceptNeedsCode = data.codeRequiredFor.includes('accept');
  const declineNeedsCode = data.codeRequiredFor.includes('decline');
  const anyCode = acceptNeedsCode || declineNeedsCode;
  const canDecide = (decisionName: 'accept' | 'decline') =>
    data.decisions.includes(decisionName) &&
    (!(decisionName === 'accept' ? acceptNeedsCode : declineNeedsCode) || code.trim() !== '');

  return shell(
    <article
      className="tm-card tm-quote-public__card tm-stack"
      aria-labelledby="tm-quote-public-title"
    >
      <p className="tm-fin-muted">
        <bdi>{data.organizationName}</bdi> · {tOr('Quotes.quoteWord', 'Quote')}{' '}
        <bdi className="tm-mono">{quote.number}</bdi>
      </p>
      <h1 id="tm-quote-public-title" className="tm-quote-public__title">
        {quote.title}
      </h1>
      <p className="tm-fin-muted">
        {tOr('Quotes.fieldValidUntil', 'Valid until')} {day(quote.validUntil)}
      </p>

      <dl className="tm-fin-totals">
        {quote.lines.map((line, index) => (
          <div key={index}>
            <dt>
              {line.description} · {line.quantity}
            </dt>
            <dd>{money(line.lineNetMinor, quote.currency)}</dd>
          </div>
        ))}
      </dl>
      <dl className="tm-fin-totals">
        <div>
          <dt>{tOr('Quotes.subtotal', 'Subtotal')}</dt>
          <dd>{money(quote.subtotalMinor, quote.currency)}</dd>
        </div>
        <div>
          <dt>{tOr('Quotes.tax', 'Tax')}</dt>
          <dd>{money(quote.taxMinor, quote.currency)}</dd>
        </div>
        <div>
          <dt>{tOr('Quotes.total', 'Total')}</dt>
          <dd>{money(quote.totalMinor, quote.currency)}</dd>
        </div>
      </dl>
      {quote.terms ? <p className="tm-quote__terms">{quote.terms}</p> : null}

      {anyCode ? (
        <div className="tm-quote-public__code">
          <Field
            label={tOr('QuoteLink.code', 'E-mail code')}
            value={code}
            inputMode="numeric"
            autoComplete="one-time-code"
            dir="ltr"
            maxLength={12}
            onChange={(event) => setCode(event.target.value)}
            hint={
              askCode.isSuccess
                ? tOr('QuoteLink.codeSent', 'We sent a code to the address this quote was sent to.')
                : undefined
            }
          />
          <Button
            type="button"
            tone="outline"
            loading={askCode.isPending}
            loadingLabel={tOr('QuoteLink.sendingCode', 'Sending a code')}
            onClick={() => askCode.mutate()}
          >
            {tOr('QuoteLink.sendCode', 'Send me a code')}
          </Button>
        </div>
      ) : null}
      {askCode.isError ? (
        <InlineAlert tone="danger" live>
          {describe(askCode.error)}
        </InlineAlert>
      ) : null}

      <div className="tm-field">
        <label className="tm-field__label" htmlFor={commentId}>
          {tOr('QuoteLink.comment', 'Note to the sender (optional)')}
        </label>
        <textarea
          id={commentId}
          className="tm-field__control"
          rows={2}
          maxLength={1000}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </div>

      {decide.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('QuoteLink.decideFailed', 'Your answer was not recorded')}
          live
        >
          {describe(decide.error)}
        </InlineAlert>
      ) : null}

      <div className="tm-row">
        <Button
          type="button"
          tone="lime"
          disabled={!canDecide('accept') || decide.isPending}
          loading={decide.isPending && decide.variables === 'accept'}
          loadingLabel={tOr('QuoteLink.accepting', 'Recording your acceptance')}
          onClick={() => decide.mutate('accept')}
        >
          {tOr('QuoteLink.accept', 'Accept quote')}
        </Button>
        <Button
          type="button"
          tone="outline"
          disabled={!canDecide('decline') || decide.isPending}
          loading={decide.isPending && decide.variables === 'decline'}
          loadingLabel={tOr('QuoteLink.declining', 'Recording your answer')}
          onClick={() => decide.mutate('decline')}
        >
          {tOr('QuoteLink.decline', 'Decline')}
        </Button>
      </div>
    </article>,
  );
}
