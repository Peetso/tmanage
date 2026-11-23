'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  DateField,
  Field,
  InlineAlert,
  LoadingRegion,
  Select,
  Skeleton,
  StateCapsule,
} from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { listClientOrganizations } from '../../../lib/api/clients';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { DocumentPdfButton, DocumentPdfFailure, useDocumentPdf } from '../finance/DocumentPdf';
import {
  deleteQuote,
  getQuote,
  quotePdfPath,
  saveQuote,
  sendQuote,
  type QuoteDocument,
} from './QuoteApi';
import { useShellCapability } from '../../shell/use-shell-capability';
import { ConfirmActionButton, conflictReason } from '../ConfirmActionButton';
import { QuoteConvertCard } from './QuoteConvertCard';
import { STATUS_WORDS } from './QuoteListScreen';
import {
  EMPTY_LINE,
  QUOTE_UNITS,
  documentToDraft,
  draftToInput,
  newDraft,
  previewTotals,
  quoteCapsule,
  quoteLinkUrl,
  type DraftLine,
  type DraftProblem,
  type QuoteDraft,
} from './QuoteRules';
import { useFormCheck } from '../../../lib/forms/form-check';
import '../../../styles/screens/finance-ledger.css';
import '../../../styles/screens/quotes.css';

export interface QuoteEditorScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** `null` writes a new quote. */
  quoteId: string | null;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const UNIT_WORDS: Record<string, readonly [string, string]> = {
  item: ['Quotes.unitItem', 'Item'],
  hour: ['Quotes.unitHour', 'Hour'],
  day: ['Quotes.unitDay', 'Day'],
  month: ['Quotes.unitMonth', 'Month'],
  fixed: ['Quotes.unitFixed', 'Fixed'],
};

const PROBLEM_WORDS: Record<string, readonly [string, string]> = {
  title: ['Quotes.problemTitle', 'Give the quote a title.'],
  client: ['Quotes.problemClient', 'Choose a client or name a new lead.'],
  currency: ['Quotes.problemCurrency', 'Use a three-letter currency code such as USD or EGP.'],
  validUntil: ['Quotes.problemValidUntil', 'Choose the last day the quote is valid.'],
  lines: ['Quotes.problemLines', 'A quote needs 1 to 100 lines.'],
  description: ['Quotes.problemDescription', 'Describe this line.'],
  quantity: ['Quotes.problemQuantity', 'Enter a quantity above 0 with at most two decimals.'],
  unitPrice: ['Quotes.problemUnitPrice', 'Enter a price with at most two decimals.'],
  taxPercent: ['Quotes.problemTax', 'Enter a tax rate from 0 to 100.'],
};

/**
 * **Quote** — write, edit and send one quote (A12), drawn as the R31 L04 Figma frame
 * "Quotes · Draft editor": details, the lines, terms, and beside them the live totals and the send
 * card. Saving is `POST|PUT …/quotes` (the server recomputes every total); sending is
 * `POST …/quotes/:id/send`, which freezes the content and returns the one-time client link. A sent,
 * accepted, declined or expired quote opens read-only.
 */
export function QuoteEditorScreen({
  organizationSlug,
  organizationName,
  quoteId,
  client,
}: QuoteEditorScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const { money, day } = useDisplayFormatters();
  const router = useRouter();
  const queryClient = useQueryClient();
  const formId = useId();
  const pdf = useDocumentPdf();
  const canUse = useShellCapability(organizationSlug, client);

  const quote = useQuery({
    queryKey: ['quote', organizationSlug, quoteId],
    queryFn: () => getQuote(api, organizationSlug, quoteId ?? ''),
    enabled: quoteId !== null,
  });
  const clients = useQuery({
    queryKey: ['quote-clients', organizationSlug],
    queryFn: () => listClientOrganizations(api, organizationSlug),
    retry: false,
  });

  const [draft, setDraft] = useState<QuoteDraft>(() => newDraft(new Date()));
  const [dirty, setDirty] = useState(false);
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [sendTo, setSendTo] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (quote.data) {
      setDraft(documentToDraft(quote.data));
      setSendTo((current) => current || quote.data.leadEmail || '');
      setDirty(false);
    }
  }, [quote.data]);

  const save = useMutation({
    mutationFn: (input: Parameters<typeof saveQuote>[3]) =>
      saveQuote(api, organizationSlug, quoteId, input),
    onSuccess: (saved) => {
      setDirty(false);
      queryClient.setQueryData(['quote', organizationSlug, saved.id], saved);
      void queryClient.invalidateQueries({ queryKey: ['quotes', organizationSlug] });
      if (quoteId === null)
        router.replace(`/${organizationSlug}/quotes/${encodeURIComponent(saved.id)}`);
    },
  });
  // QA-FIX-S M2: the "Send to" address is checked in the app's words, never the browser bubble.
  const sendCheck = useFormCheck();
  const send = useMutation({
    mutationFn: () => sendQuote(api, organizationSlug, quoteId ?? '', sendTo.trim()),
    onSuccess: (sent) => {
      setLink(quoteLinkUrl(window.location.origin, sent.link.token));
      void queryClient.invalidateQueries({ queryKey: ['quote', organizationSlug, quoteId] });
      void queryClient.invalidateQueries({ queryKey: ['quotes', organizationSlug] });
    },
  });

  const change = (patch: Partial<QuoteDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
    setProblem(null);
  };
  const changeLine = (index: number, patch: Partial<DraftLine>) =>
    change({ lines: draft.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) });

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    const result = draftToInput(draft, quote.data?.version ?? null);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    save.mutate(result.input);
  };

  const copy = async () => {
    if (link === null) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const title = quote.data?.title || tOr('Quotes.newTitle', 'New quote');
  const eyebrow = quote.data
    ? `${tOr('Quotes.title', 'Quotes')} · ${quote.data.number}`
    : tOr('Quotes.title', 'Quotes');
  const lineError = (index: number, field: string) =>
    problem !== null &&
    typeof problem !== 'string' &&
    problem.line === index &&
    problem.field === field
      ? tOr(...(PROBLEM_WORDS[field] ?? PROBLEM_WORDS['lines']!))
      : undefined;
  const fieldError = (key: string) =>
    problem === key ? tOr(...(PROBLEM_WORDS[key] ?? PROBLEM_WORDS['lines']!)) : undefined;

  if (quoteId !== null && (quote.isPending || quote.isError)) {
    return (
      <AppShell
        organizationSlug={organizationSlug}
        organizationName={organizationName}
        activeNavigationId="finance"
        eyebrow={tOr('Quotes.title', 'Quotes')}
        title={tOr('Quotes.quoteWord', 'Quote')}
      >
        {quote.isPending ? (
          <LoadingRegion label={tOr('Quotes.loadingOne', 'Loading the quote')} className="tm-stack">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : (
          <InlineAlert
            tone="danger"
            title={tOr('Quotes.errorOne', 'The quote could not load')}
            live
          >
            {describe(quote.error)}
          </InlineAlert>
        )}
      </AppShell>
    );
  }

  const readOnly = quote.data !== undefined && quote.data.status !== 'draft';
  const totals = readOnly && quote.data ? quote.data : previewTotals(draft.lines);
  const currency = (quote.data?.currency ?? draft.currency).toUpperCase() || 'USD';
  const clientName = (doc: QuoteDocument) =>
    (clients.data ?? []).find((entry) => entry.id === doc.clientOrganizationId)?.name ??
    doc.leadName ??
    '—';

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="finance"
      eyebrow={eyebrow}
      title={title}
      titleMeta={
        quote.data
          ? `${tOr(...STATUS_WORDS[quote.data.status])} · ${tOr('Quotes.validUntilWord', 'valid until')} ${day(quote.data.validUntil)}`
          : undefined
      }
      actions={
        <div className="tm-row">
          <Link
            className="tm-button tm-button--outline tm-button--default"
            href={`/${organizationSlug}/quotes`}
          >
            {tOr('Quotes.backToList', 'All quotes')}
          </Link>
          {quote.data ? (
            <DocumentPdfButton
              pdf={pdf}
              path={quotePdfPath(organizationSlug, quote.data.id)}
              fileName={`${quote.data.number}.pdf`}
            />
          ) : null}
          {/* Fix lane C: a draft only (`project.manage`); a sent quote is kept. */}
          {quote.data?.status === 'draft' && canUse('project.manage') ? (
            <ConfirmActionButton
              triggerLabel={tOr('Quotes.deleteDraft', 'Delete draft')}
              title={tOr('Quotes.deleteDraftTitle', 'Delete the draft quote {number}?')
                .split('{number}')
                .join(quote.data.number)}
              body={tOr(
                'Quotes.deleteDraftBody',
                'The draft goes for good. Your client has not seen it. This cannot be undone.',
              )}
              confirmLabel={tOr('Quotes.deleteDraftConfirm', 'Delete draft')}
              busyLabel={tOr('Quotes.deletingDraft', 'Deleting…')}
              failedTitle={tOr('Quotes.deleteDraftFailed', 'Draft not deleted')}
              explainFailure={(failure) =>
                conflictReason(failure) === 'not_draft'
                  ? tOr(
                      'Quotes.deleteNotDraft',
                      'This quote was already sent, so it is kept. Refresh the page to see it.',
                    )
                  : null
              }
              onConfirm={() => deleteQuote(api, organizationSlug, quote.data?.id ?? '')}
              onDone={() => {
                void queryClient.invalidateQueries({ queryKey: ['quotes', organizationSlug] });
                router.push(`/${organizationSlug}/quotes`);
              }}
            />
          ) : null}
        </div>
      }
    >
      <div className="tm-stack">
        <DocumentPdfFailure pdf={pdf} />
        <div className="tm-fin tm-quote">
          {readOnly && quote.data ? (
            <section className="tm-card tm-stack" aria-labelledby="tm-quote-sent-heading">
              <div className="tm-row">
                <h2 id="tm-quote-sent-heading" className="tm-fin-card-title">
                  {tOr('Quotes.linesTitle', 'Lines')}
                </h2>
                <StateCapsule state={quoteCapsule(quote.data.status)}>
                  {tOr(...STATUS_WORDS[quote.data.status])}
                </StateCapsule>
              </div>
              <p className="tm-fin-muted">
                {tOr('Quotes.colClient', 'Client')}: {clientName(quote.data)}
              </p>
              <div className="tm-fin-table-card">
                <table className="tm-table">
                  <thead>
                    <tr>
                      <th scope="col">{tOr('Quotes.colDescription', 'Description')}</th>
                      <th scope="col">{tOr('Quotes.colQuantity', 'Quantity')}</th>
                      <th scope="col" className="tm-fin-num">
                        {tOr('Quotes.colUnitPrice', 'Unit price')}
                      </th>
                      <th scope="col" className="tm-fin-num">
                        {tOr('Quotes.colLineTotal', 'Line total')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {quote.data.lines.map((line) => (
                      <tr key={line.position}>
                        <td>{line.description}</td>
                        <td>
                          {line.quantity} {tOr(...(UNIT_WORDS[line.unit] ?? UNIT_WORDS['item']!))}
                        </td>
                        <td className="tm-mono tm-fin-num">
                          {money(line.unitPriceMinor, currency)}
                        </td>
                        <td className="tm-mono tm-fin-num">
                          {money(line.lineNetMinor + line.lineTaxMinor, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {quote.data.terms ? <p className="tm-quote__terms">{quote.data.terms}</p> : null}
            </section>
          ) : (
            <form id={formId} className="tm-stack" onSubmit={onSave} noValidate>
              <section className="tm-card tm-stack" aria-labelledby="tm-quote-details-heading">
                <h2 id="tm-quote-details-heading" className="tm-fin-card-title">
                  {tOr('Quotes.detailsTitle', 'Details')}
                </h2>
                <div className="tm-quote__grid">
                  <Field
                    label={tOr('Quotes.fieldTitle', 'Title')}
                    value={draft.title}
                    maxLength={200}
                    onChange={(event) => change({ title: event.target.value })}
                    error={fieldError('title')}
                    required
                  />
                  <Select
                    label={tOr('Quotes.fieldClient', 'Client')}
                    value={draft.clientOrganizationId}
                    onChange={(event) => change({ clientOrganizationId: event.target.value })}
                    error={fieldError('client')}
                  >
                    <option value="">{tOr('Quotes.newLead', 'A new lead')}</option>
                    {(clients.data ?? [])
                      .filter((entry) => entry.archivedAt === null)
                      .map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                  </Select>
                  {draft.clientOrganizationId === '' ? (
                    <>
                      <Field
                        label={tOr('Quotes.fieldLeadName', 'Lead name')}
                        value={draft.leadName}
                        maxLength={200}
                        onChange={(event) => change({ leadName: event.target.value })}
                      />
                      <Field
                        label={tOr('Quotes.fieldLeadEmail', 'Lead e-mail')}
                        type="email"
                        value={draft.leadEmail}
                        maxLength={320}
                        onChange={(event) => change({ leadEmail: event.target.value })}
                      />
                    </>
                  ) : null}
                  <Field
                    label={tOr('Quotes.fieldCurrency', 'Currency')}
                    value={draft.currency}
                    maxLength={3}
                    dir="ltr"
                    onChange={(event) => change({ currency: event.target.value.toUpperCase() })}
                    error={fieldError('currency')}
                  />
                  <Select
                    label={tOr('Quotes.fieldLanguage', 'Language')}
                    value={draft.language}
                    onChange={(event) => change({ language: event.target.value })}
                  >
                    <option value="en">English</option>
                    <option value="ar">العربية</option>
                  </Select>
                  <DateField
                    label={tOr('Quotes.fieldValidUntil', 'Valid until')}
                    value={draft.validUntil}
                    onValueChange={(value) => change({ validUntil: value })}
                    error={fieldError('validUntil')}
                  />
                </div>
              </section>

              <section className="tm-card tm-stack" aria-labelledby="tm-quote-lines-heading">
                <h2 id="tm-quote-lines-heading" className="tm-fin-card-title">
                  {tOr('Quotes.linesTitle', 'Lines')}
                </h2>
                {fieldError('lines') ? (
                  <InlineAlert tone="danger" live>
                    {fieldError('lines')}
                  </InlineAlert>
                ) : null}
                <ol className="tm-quote__lines">
                  {draft.lines.map((line, index) => (
                    <li key={index} className="tm-quote__line">
                      <Field
                        label={tOr('Quotes.colDescription', 'Description')}
                        value={line.description}
                        maxLength={500}
                        onChange={(event) => changeLine(index, { description: event.target.value })}
                        error={lineError(index, 'description')}
                      />
                      <Select
                        label={tOr('Quotes.colUnit', 'Unit')}
                        value={line.unit}
                        onChange={(event) => changeLine(index, { unit: event.target.value })}
                      >
                        {QUOTE_UNITS.map((unit) => (
                          <option key={unit} value={unit}>
                            {tOr(...UNIT_WORDS[unit]!)}
                          </option>
                        ))}
                      </Select>
                      <Field
                        label={tOr('Quotes.colQuantity', 'Quantity')}
                        inputMode="decimal"
                        dir="ltr"
                        value={line.quantity}
                        onChange={(event) => changeLine(index, { quantity: event.target.value })}
                        error={lineError(index, 'quantity')}
                      />
                      <Field
                        label={tOr('Quotes.colUnitPrice', 'Unit price')}
                        inputMode="decimal"
                        dir="ltr"
                        value={line.unitPrice}
                        onChange={(event) => changeLine(index, { unitPrice: event.target.value })}
                        error={lineError(index, 'unitPrice')}
                      />
                      <Field
                        label={tOr('Quotes.colTax', 'Tax %')}
                        inputMode="decimal"
                        dir="ltr"
                        value={line.taxPercent}
                        onChange={(event) => changeLine(index, { taxPercent: event.target.value })}
                        error={lineError(index, 'taxPercent')}
                      />
                      {draft.lines.length > 1 ? (
                        <Button
                          type="button"
                          tone="text"
                          size="compact"
                          onClick={() =>
                            change({ lines: draft.lines.filter((_, i) => i !== index) })
                          }
                        >
                          {tOr('Quotes.removeLine', 'Remove')}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ol>
                <div className="tm-row">
                  <Button
                    type="button"
                    tone="outline"
                    size="compact"
                    disabled={draft.lines.length >= 100}
                    onClick={() => change({ lines: [...draft.lines, EMPTY_LINE] })}
                  >
                    {tOr('Quotes.addLine', 'Add line')}
                  </Button>
                </div>
              </section>

              <section className="tm-card tm-stack" aria-labelledby="tm-quote-terms-heading">
                <h2 id="tm-quote-terms-heading" className="tm-visually-hidden">
                  {tOr('Quotes.termsTitle', 'Terms')}
                </h2>
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor={`${formId}-terms`}>
                    {tOr('Quotes.fieldTerms', 'Terms the client sees')}
                  </label>
                  <textarea
                    id={`${formId}-terms`}
                    className="tm-field__control"
                    rows={3}
                    maxLength={5000}
                    value={draft.terms}
                    onChange={(event) => change({ terms: event.target.value })}
                  />
                </div>
                <div className="tm-field">
                  <label className="tm-field__label" htmlFor={`${formId}-notes`}>
                    {tOr('Quotes.fieldNotes', 'Internal notes')}
                  </label>
                  <textarea
                    id={`${formId}-notes`}
                    className="tm-field__control"
                    rows={2}
                    maxLength={5000}
                    value={draft.notes}
                    onChange={(event) => change({ notes: event.target.value })}
                  />
                  <p className="tm-field__hint">
                    {tOr('Quotes.notesHint', 'Not shown to the client.')}
                  </p>
                </div>
              </section>
            </form>
          )}

          <div className="tm-fin-col">
            <section className="tm-card tm-stack" aria-labelledby="tm-quote-totals-heading">
              <h2 id="tm-quote-totals-heading" className="tm-fin-card-title">
                {tOr('Quotes.totalsTitle', 'Totals')}
              </h2>
              <dl className="tm-fin-totals">
                <div>
                  <dt>{tOr('Quotes.subtotal', 'Subtotal')}</dt>
                  <dd>{money(totals.subtotalMinor, currency)}</dd>
                </div>
                <div>
                  <dt>{tOr('Quotes.tax', 'Tax')}</dt>
                  <dd>{money(totals.taxMinor, currency)}</dd>
                </div>
                <div>
                  <dt>{tOr('Quotes.total', 'Total')}</dt>
                  <dd>{money(totals.totalMinor, currency)}</dd>
                </div>
              </dl>

              {!readOnly ? (
                <>
                  <Button
                    type="submit"
                    form={formId}
                    tone="ink"
                    loading={save.isPending}
                    loadingLabel={tOr('Quotes.saving', 'Saving the draft')}
                  >
                    {tOr('Quotes.saveDraft', 'Save draft')}
                  </Button>
                  {/* QA-FIX-R L14: the same reason as at the field, beside the button. */}
                  {problem !== null ? (
                    <InlineAlert
                      tone="danger"
                      title={tOr('Quotes.saveFailed', 'The draft was not saved')}
                      live
                    >
                      {typeof problem === 'string'
                        ? tOr(...(PROBLEM_WORDS[problem] ?? PROBLEM_WORDS['lines']!))
                        : tOr('InvoiceEditor.lineProblem', 'Line {n}: {problem}')
                            .replace('{n}', String(problem.line + 1))
                            .replace(
                              '{problem}',
                              tOr(...(PROBLEM_WORDS[problem.field] ?? PROBLEM_WORDS['lines']!)),
                            )}
                    </InlineAlert>
                  ) : null}
                  {save.isError ? (
                    <InlineAlert
                      tone="danger"
                      title={tOr('Quotes.saveFailed', 'The draft was not saved')}
                      live
                    >
                      {describe(save.error)}
                    </InlineAlert>
                  ) : null}
                  {quoteId !== null ? (
                    <form
                      noValidate
                      className="tm-stack tm-stack--tight"
                      {...sendCheck.handlers(() => send.mutate())}
                    >
                      <Field
                        label={tOr('Quotes.sendTo', 'Send to')}
                        type="email"
                        name="sendTo"
                        error={sendCheck.error('sendTo')}
                        dir="ltr"
                        value={sendTo}
                        maxLength={320}
                        onChange={(event) => setSendTo(event.target.value)}
                        hint={
                          dirty
                            ? tOr('Quotes.saveFirst', 'Save the draft before sending it.')
                            : tOr(
                                'Quotes.sendHint',
                                'The client gets a private link and confirms with an e-mail code.',
                              )
                        }
                        required
                      />
                      <Button
                        type="submit"
                        tone="lime"
                        disabled={dirty || sendTo.trim() === ''}
                        loading={send.isPending}
                        loadingLabel={tOr('Quotes.sending', 'Sending the quote')}
                      >
                        {tOr('Quotes.send', 'Send to client')}
                      </Button>
                      {send.isError ? (
                        <InlineAlert
                          tone="danger"
                          title={tOr('Quotes.sendFailed', 'The quote was not sent')}
                          live
                        >
                          {describe(send.error)}
                        </InlineAlert>
                      ) : null}
                    </form>
                  ) : null}
                </>
              ) : null}

              {link !== null ? (
                <div className="tm-stack tm-stack--tight">
                  <InlineAlert tone="success" title={tOr('Quotes.sentTitle', 'Quote sent')} live>
                    {tOr(
                      'Quotes.sentBody',
                      'Share this link with the client. It is shown once; the client confirms with a code sent to their e-mail.',
                    )}
                  </InlineAlert>
                  <p className="tm-quote__link" dir="ltr">
                    {link}
                  </p>
                  <Button type="button" tone="outline" size="compact" onClick={() => void copy()}>
                    {copied ? tOr('Quotes.copied', 'Copied') : tOr('Quotes.copyLink', 'Copy link')}
                  </Button>
                </div>
              ) : null}
            </section>
            {quote.data?.status === 'accepted' ? (
              <QuoteConvertCard api={api} organizationSlug={organizationSlug} quote={quote.data} />
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
