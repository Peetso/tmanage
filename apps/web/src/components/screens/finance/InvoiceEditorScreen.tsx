'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { listClientOrganizations } from '../../../lib/api/clients';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { EXPENSE_CURRENCIES } from '../../../lib/finance-presentation';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { FinanceReportSectionTabs } from './FinanceReportSectionTabs';
import {
  createClientInvoice,
  getClientInvoice,
  pullInvoiceLines,
  updateClientInvoice,
  type ClientInvoiceDocument,
  type InvoicePullResult,
} from './InvoiceApi';
import {
  INVOICE_LINE_UNITS,
  emptyLine,
  linesFromDocument,
  linesToBody,
  previewInvoiceTotals,
  type InvoiceDraftLine,
  type LineProblem,
} from './InvoiceFormRules';
import { minutesAsHours } from './InvoiceRules';
import '../../../styles/screens/finance-ledger.css';
import '../../../styles/screens/finance-invoice-editor.css';
import { MoreOptions, useMyUserId } from '../../forms/MoreOptions';

export interface InvoiceEditorScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** `null` writes a new draft. */
  invoiceId: string | null;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const UNIT_WORDS: Record<string, readonly [string, string]> = {
  item: ['InvoiceEditor.unitItem', 'Item'],
  hour: ['InvoiceEditor.unitHour', 'Hour'],
  day: ['InvoiceEditor.unitDay', 'Day'],
  month: ['InvoiceEditor.unitMonth', 'Month'],
  fixed: ['InvoiceEditor.unitFixed', 'Fixed'],
};

const PROBLEM_WORDS: Record<string, readonly [string, string]> = {
  client: ['InvoiceEditor.problemClient', 'Choose the client this invoice is for.'],
  description: ['InvoiceEditor.problemDescription', 'Describe this line.'],
  quantity: [
    'InvoiceEditor.problemQuantity',
    'Enter a quantity above 0 with at most two decimals.',
  ],
  unitPrice: ['InvoiceEditor.problemUnitPrice', 'Enter a price such as 450 or 450.50.'],
  taxPercent: ['InvoiceEditor.problemTax', 'Enter a tax rate from 0 to 100.'],
  dueDate: ['InvoiceEditor.problemDueDate', 'The due date cannot be before the issue date.'],
  period: [
    'InvoiceEditor.problemPeriod',
    'Choose both ends of the period, the end after the start.',
  ],
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * **New invoice / Edit draft** (52-09), drawn as the R35 L6-52-09 Figma frame "Invoice editor":
 * details (client, currency, issue and due date), the lines — typed, fixed amounts, or brought in
 * from approved time, approved expenses and the retainer period — and beside them the live totals.
 * Saving is `POST …/client-invoices` then `PUT …/:id` with the lines; the server recomputes every
 * total, re-checks `finance.manage` and refuses any invoice that is no longer a draft.
 */
export function InvoiceEditorScreen({
  organizationSlug,
  organizationName,
  invoiceId,
  client,
}: InvoiceEditorScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const myUserId = useMyUserId(api, organizationSlug);
  const describe = useDescribeApiError();
  const arabic = useActiveLocale().startsWith('ar');
  const { money } = useDisplayFormatters();
  const router = useRouter();
  const queryClient = useQueryClient();

  const invoice = useQuery({
    queryKey: ['client-invoice', organizationSlug, invoiceId],
    queryFn: () => getClientInvoice(api, organizationSlug, invoiceId ?? ''),
    enabled: invoiceId !== null,
  });
  const clients = useQuery({
    queryKey: ['finance-client-names', organizationSlug],
    queryFn: () => listClientOrganizations(api, organizationSlug),
    retry: false,
  });
  const activeClients = (clients.data ?? []).filter((entry) => entry.archivedAt === null);

  const [clientId, setClientId] = useState('');
  const [currency, setCurrency] = useState('');
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState('');
  const [lines, setLines] = useState<InvoiceDraftLine[]>(() => [emptyLine('item', '15')]);
  const [dirty, setDirty] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [lineProblem, setLineProblem] = useState<LineProblem | null>(null);
  const [pullFrom, setPullFrom] = useState('');
  const [pullTo, setPullTo] = useState('');
  const [pullTime, setPullTime] = useState(true);
  const [pullExpenses, setPullExpenses] = useState(true);
  const [pullRetainer, setPullRetainer] = useState(false);
  const [pulled, setPulled] = useState<InvoicePullResult | null>(null);

  const loaded = invoice.data;
  useEffect(() => {
    if (!loaded) return;
    setClientId(loaded.clientOrganizationId);
    setCurrency(loaded.currency);
    setIssueDate(loaded.issueDate ?? today());
    setDueDate(loaded.dueDate ?? '');
    setLines(linesFromDocument(loaded, arabic));
    setPullFrom((current) => current || loaded.periodStart || '');
    setPullTo((current) => current || loaded.periodEnd || '');
    setDirty(false);
  }, [loaded, arabic]);

  const docCurrency = loaded?.currency ?? (currency || 'SAR');
  const totals = previewInvoiceTotals(lines, docCurrency);
  const chosenClient = clientId || activeClients[0]?.id || '';
  const editable = invoiceId === null || loaded?.state === 'draft';

  const remember = (saved: ClientInvoiceDocument) => {
    queryClient.setQueryData(['client-invoice', organizationSlug, saved.id], saved);
    void queryClient.invalidateQueries({ queryKey: ['client-invoices', organizationSlug] });
  };

  const created = useRef<ClientInvoiceDocument | null>(null);
  const save = useMutation({
    mutationFn: async (body: ReturnType<typeof linesToBody> & { ok: true }) => {
      let base = loaded ?? created.current ?? undefined;
      if (invoiceId === null && base === undefined) {
        // Kept, so a retry after a failed line save fills this draft instead of opening another.
        base = await createClientInvoice(api, organizationSlug, {
          clientOrganizationId: chosenClient,
          currency: currency === '' ? null : currency,
          issueDate,
        });
        created.current = base;
      }
      if (!base) throw new Error('invoice not loaded');
      return updateClientInvoice(api, organizationSlug, base.id, {
        expectedVersion: base.version,
        issueDate,
        ...(dueDate === '' ? {} : { dueDate }),
        lines: body.lines,
      });
    },
    onSuccess: (saved) => {
      setDirty(false);
      remember(saved);
      if (invoiceId === null) {
        router.replace(
          `/${organizationSlug}/finance/invoices/${encodeURIComponent(saved.id)}/edit`,
        );
      }
    },
  });

  const pull = useMutation({
    mutationFn: () =>
      pullInvoiceLines(api, organizationSlug, invoiceId ?? '', {
        period: { from: pullFrom, to: pullTo },
        include: { time: pullTime, expenses: pullExpenses, retainer: pullRetainer },
      }),
    onSuccess: (result) => {
      setPulled(result);
      remember(result.invoice);
    },
  });

  const changeLine = (index: number, patch: Partial<InvoiceDraftLine>) => {
    setLines((current) => current.map((line, at) => (at === index ? { ...line, ...patch } : line)));
    setDirty(true);
    setLineProblem(null);
  };

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    if (invoiceId === null && chosenClient === '') {
      setProblem('client');
      return;
    }
    if (dueDate !== '' && dueDate < issueDate) {
      setProblem('dueDate');
      return;
    }
    const body = linesToBody(lines, docCurrency, arabic);
    if (!body.ok) {
      setLineProblem(body.problem);
      setProblem(body.problem.field);
      return;
    }
    save.mutate(body);
  };

  const onPull = () => {
    setProblem(null);
    if (pullFrom === '' || pullTo === '' || pullTo < pullFrom) {
      setProblem('period');
      return;
    }
    pull.mutate();
  };

  const title =
    invoiceId === null
      ? tOr('InvoiceEditor.newTitle', 'New invoice')
      : (loaded?.number ?? tOr('InvoiceEditor.editTitle', 'Edit draft'));

  // 55-08: a new invoice asks for client, currency and lines first; the dates default (today,
  // and the client's payment terms) and sit behind "More options".
  const dateFields = (
    <>
      <Field
        label={tOr('InvoiceEditor.issueDate', 'Issue date')}
        type="date"
        value={issueDate}
        onChange={(event) => {
          setIssueDate(event.target.value);
          setDirty(true);
        }}
      />
      <Field
        label={tOr('InvoiceEditor.dueDate', 'Due date')}
        type="date"
        value={dueDate}
        hint={tOr('InvoiceEditor.dueDateHint', 'From the client’s payment terms')}
        error={problem === 'dueDate' ? tOr(...PROBLEM_WORDS['dueDate']!) : undefined}
        onChange={(event) => {
          setDueDate(event.target.value);
          setDirty(true);
        }}
      />
    </>
  );

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={tOr('InvoiceList.title', 'Invoices')}
      title={title}
      actions={
        <Link
          className="tm-chip"
          href={
            invoiceId === null
              ? `/${organizationSlug}/finance/invoices`
              : `/${organizationSlug}/finance/invoices/${encodeURIComponent(invoiceId)}`
          }
        >
          {invoiceId === null
            ? tOr('InvoiceDetail.back', 'All invoices')
            : tOr('InvoiceEditor.backToInvoice', 'Back to the invoice')}
        </Link>
      }
    >
      <div className="tm-stack">
        <FinanceReportSectionTabs organizationSlug={organizationSlug} current="invoices" />

        {invoice.isPending && invoiceId !== null ? (
          <LoadingRegion
            label={tOr('InvoiceDetail.loading', 'Loading the invoice')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}
        {invoice.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('InvoiceDetail.errorTitle', 'The invoice could not load')}
            live
          >
            {describe(invoice.error)}
          </InlineAlert>
        ) : null}
        {loaded && !editable ? (
          <InlineAlert tone="neutral" title={tOr('InvoiceEditor.lockedTitle', 'Already issued')}>
            {tOr(
              'InvoiceEditor.lockedBody',
              'Only a draft can be edited. Correct an issued invoice with a credit note.',
            )}
          </InlineAlert>
        ) : null}

        {editable && (invoiceId === null || loaded) ? (
          <form className="tm-fin tm-inv-editor" onSubmit={onSave} noValidate>
            <div className="tm-stack">
              <section className="tm-card tm-stack" aria-labelledby="tm-inv-details">
                <h2 id="tm-inv-details" className="tm-fin-card-title">
                  {tOr('InvoiceEditor.details', 'Details')}
                </h2>
                <div className="tm-fin-form">
                  {invoiceId === null ? (
                    <Select
                      label={tOr('InvoiceEditor.client', 'Client')}
                      value={chosenClient}
                      error={problem === 'client' ? tOr(...PROBLEM_WORDS['client']!) : undefined}
                      onChange={(event) => {
                        setClientId(event.target.value);
                        setDirty(true);
                      }}
                    >
                      {activeClients.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Field
                      label={tOr('InvoiceEditor.client', 'Client')}
                      value={
                        (clients.data ?? []).find((entry) => entry.id === clientId)?.name ?? '—'
                      }
                      readOnly
                    />
                  )}
                  {invoiceId === null ? (
                    <Select
                      label={tOr('InvoiceEditor.currency', 'Currency')}
                      value={currency}
                      onChange={(event) => setCurrency(event.target.value)}
                    >
                      <option value="">
                        {tOr('InvoiceEditor.currencyClientDefault', 'Client default')}
                      </option>
                      {EXPENSE_CURRENCIES.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Field
                      label={tOr('InvoiceEditor.currency', 'Currency')}
                      value={docCurrency}
                      readOnly
                    />
                  )}
                  {invoiceId === null ? null : dateFields}
                </div>
                {invoiceId === null ? (
                  <MoreOptions
                    form="invoice"
                    userId={myUserId}
                    hint={tOr('MoreOptions.invoiceHint', 'Issue date, due date')}
                    forceOpen={problem === 'dueDate'}
                  >
                    <div className="tm-fin-form">{dateFields}</div>
                  </MoreOptions>
                ) : null}
              </section>

              <section className="tm-card tm-stack" aria-labelledby="tm-inv-lines">
                <h2 id="tm-inv-lines" className="tm-fin-card-title">
                  {tOr('InvoiceEditor.lines', 'Lines')}
                </h2>
                {lines.length === 0 ? (
                  <p className="tm-fin-muted">
                    {tOr('InvoiceEditor.noLines', 'Add a line or bring in approved work.')}
                  </p>
                ) : null}
                <ol className="tm-inv-lines">
                  {lines.map((line, index) => {
                    const at = (field: string) =>
                      lineProblem?.index === index && lineProblem.field === field
                        ? tOr(...PROBLEM_WORDS[field]!)
                        : undefined;
                    return (
                      <li key={line.id ?? `new-${String(index)}`} className="tm-inv-line">
                        <Field
                          className="tm-inv-line__description"
                          label={tOr('InvoiceDetail.colDescription', 'Description')}
                          value={line.description}
                          maxLength={500}
                          error={at('description')}
                          onChange={(event) =>
                            changeLine(index, { description: event.target.value })
                          }
                        />
                        <Field
                          label={tOr('InvoiceDetail.colQuantity', 'Quantity')}
                          inputMode="decimal"
                          value={line.quantity}
                          error={at('quantity')}
                          onChange={(event) => changeLine(index, { quantity: event.target.value })}
                        />
                        <Select
                          label={tOr('InvoiceEditor.unit', 'Unit')}
                          value={line.unit}
                          onChange={(event) => changeLine(index, { unit: event.target.value })}
                        >
                          {INVOICE_LINE_UNITS.map((unit) => (
                            <option key={unit} value={unit}>
                              {tOr(...UNIT_WORDS[unit]!)}
                            </option>
                          ))}
                        </Select>
                        <Field
                          label={`${tOr('InvoiceDetail.colUnitPrice', 'Unit price')} (${docCurrency})`}
                          inputMode="decimal"
                          value={line.unitPrice}
                          error={at('unitPrice')}
                          onChange={(event) => changeLine(index, { unitPrice: event.target.value })}
                        />
                        <Field
                          label={tOr('InvoiceEditor.taxPercent', 'Tax %')}
                          inputMode="decimal"
                          value={line.taxPercent}
                          error={at('taxPercent')}
                          onChange={(event) =>
                            changeLine(index, { taxPercent: event.target.value })
                          }
                        />
                        <output className="tm-mono tm-fin-num tm-inv-line__total">
                          {money(totals.lines[index]?.lineGrossMinor ?? 0, docCurrency)}
                        </output>
                        <Button
                          type="button"
                          tone="text"
                          size="compact"
                          onClick={() => {
                            setLines((current) => current.filter((_, i) => i !== index));
                            setDirty(true);
                          }}
                        >
                          {tOr('InvoiceEditor.removeLine', 'Remove')}
                        </Button>
                      </li>
                    );
                  })}
                </ol>
                <div className="tm-row">
                  <Button
                    type="button"
                    tone="outline"
                    onClick={() => {
                      setLines((current) => [...current, emptyLine('item', '15')]);
                      setDirty(true);
                    }}
                  >
                    {tOr('InvoiceEditor.addLine', 'Add line')}
                  </Button>
                  <Button
                    type="button"
                    tone="text"
                    onClick={() => {
                      setLines((current) => [...current, emptyLine('fixed', '15')]);
                      setDirty(true);
                    }}
                  >
                    {tOr('InvoiceEditor.addFixed', 'Add fixed amount')}
                  </Button>
                </div>
              </section>

              <section className="tm-card tm-stack" aria-labelledby="tm-inv-bring">
                <h2 id="tm-inv-bring" className="tm-fin-card-title">
                  {tOr('InvoiceEditor.bringTitle', 'Bring in approved work')}
                </h2>
                {invoiceId === null ? (
                  <p className="tm-fin-muted">
                    {tOr(
                      'InvoiceEditor.bringAfterSave',
                      'Save the draft first, then bring in approved time and expenses.',
                    )}
                  </p>
                ) : (
                  <>
                    <div className="tm-fin-form">
                      <Field
                        label={tOr('InvoiceEditor.from', 'From')}
                        type="date"
                        value={pullFrom}
                        error={problem === 'period' ? tOr(...PROBLEM_WORDS['period']!) : undefined}
                        onChange={(event) => setPullFrom(event.target.value)}
                      />
                      <Field
                        label={tOr('InvoiceEditor.to', 'To')}
                        type="date"
                        value={pullTo}
                        onChange={(event) => setPullTo(event.target.value)}
                      />
                    </div>
                    <div className="tm-row">
                      <Checkbox
                        label={tOr('InvoiceEditor.pullTime', 'Approved time')}
                        checked={pullTime}
                        onChange={(event) => setPullTime(event.target.checked)}
                      />
                      <Checkbox
                        label={tOr('InvoiceEditor.pullExpenses', 'Approved expenses')}
                        checked={pullExpenses}
                        onChange={(event) => setPullExpenses(event.target.checked)}
                      />
                      <Checkbox
                        label={tOr('InvoiceEditor.pullRetainer', 'Retainer period')}
                        checked={pullRetainer}
                        onChange={(event) => setPullRetainer(event.target.checked)}
                      />
                    </div>
                    {dirty ? (
                      <p className="tm-fin-muted">
                        {tOr(
                          'InvoiceEditor.saveBeforePull',
                          'Save your changes before bringing in work.',
                        )}
                      </p>
                    ) : null}
                    <div>
                      <Button
                        type="button"
                        tone="outline"
                        disabled={dirty || !(pullTime || pullExpenses || pullRetainer)}
                        loading={pull.isPending}
                        loadingLabel={tOr('InvoiceEditor.pulling', 'Bringing in')}
                        onClick={onPull}
                      >
                        {tOr('InvoiceEditor.bringButton', 'Bring in')}
                      </Button>
                    </div>
                    {pull.isError ? (
                      <InlineAlert tone="danger" live>
                        {describe(pull.error)}
                      </InlineAlert>
                    ) : null}
                    {pulled && (pulled.waiting.minutes > 0 || pulled.unpriced.minutes > 0) ? (
                      <InlineAlert tone="warning" live>
                        {pulled.waiting.minutes > 0
                          ? `${tOr('InvoiceEditor.waitingHours', 'Hours still waiting for approval')}: ${minutesAsHours(pulled.waiting.minutes)}. `
                          : ''}
                        {pulled.unpriced.minutes > 0
                          ? `${tOr('InvoiceEditor.unpricedHours', 'Hours without a rate')}: ${minutesAsHours(pulled.unpriced.minutes)}.`
                          : ''}
                      </InlineAlert>
                    ) : null}
                  </>
                )}
              </section>
            </div>

            <div className="tm-fin-col">
              <section className="tm-card tm-stack" aria-labelledby="tm-inv-totals">
                <h2 id="tm-inv-totals" className="tm-fin-card-title">
                  {tOr('InvoiceEditor.totals', 'Totals')}
                </h2>
                <dl className="tm-fin-totals">
                  <div>
                    <dt>{tOr('InvoiceDetail.subtotal', 'Subtotal')}</dt>
                    <dd>{money(totals.subtotalMinor, docCurrency)}</dd>
                  </div>
                  {totals.discountMinor > 0 ? (
                    <div>
                      <dt>{tOr('InvoiceDetail.discount', 'Discount')}</dt>
                      <dd>{money(totals.discountMinor, docCurrency)}</dd>
                    </div>
                  ) : null}
                  {totals.taxByRate.map((rate) => (
                    <div key={rate.taxBp}>
                      <dt>
                        {tOr('InvoiceDetail.tax', 'Tax')} {rate.taxBp / 100}%
                      </dt>
                      <dd>{money(rate.taxMinor, docCurrency)}</dd>
                    </div>
                  ))}
                  <div>
                    <dt>{tOr('InvoiceDetail.total', 'Total')}</dt>
                    <dd>{money(totals.totalMinor, docCurrency)}</dd>
                  </div>
                </dl>
                <p className="tm-fin-muted">
                  {tOr('InvoiceEditor.liveTotals', 'Totals update as you type.')}
                </p>
                {save.isError ? (
                  <InlineAlert tone="danger" live>
                    {describe(save.error)}
                  </InlineAlert>
                ) : null}
                {/* QA-FIX-R L14: the lines sit far from Save draft, so a refused line (a tax of
                    250 %) showed its message only up there while Save looked like it did nothing
                    and the total read 0.00. The reason is repeated beside the button, with the
                    line it is on (GOV.UK error summary; NN/g: say what went wrong and where). */}
                {lineProblem !== null || problem === 'client' || problem === 'dueDate' ? (
                  <InlineAlert
                    tone="danger"
                    title={tOr('InvoiceEditor.notSavedTitle', 'The draft was not saved')}
                    live
                  >
                    {lineProblem !== null
                      ? tOr('InvoiceEditor.lineProblem', 'Line {n}: {problem}')
                          .replace('{n}', String(lineProblem.index + 1))
                          .replace('{problem}', tOr(...PROBLEM_WORDS[lineProblem.field]!))
                      : tOr(...PROBLEM_WORDS[problem ?? 'client']!)}
                  </InlineAlert>
                ) : null}
                <div>
                  <Button
                    type="submit"
                    tone="ink"
                    loading={save.isPending}
                    loadingLabel={tOr('InvoiceEditor.saving', 'Saving')}
                  >
                    {tOr('InvoiceEditor.save', 'Save draft')}
                  </Button>
                </div>
              </section>
            </div>
          </form>
        ) : null}
      </div>
    </AppShell>
  );
}
