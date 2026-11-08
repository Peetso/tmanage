'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Select } from '@tmanage/ui';
import { apiBaseUrl } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import {
  invoicePrintUrl,
  recordInvoicePayment,
  sendClientInvoice,
  type ClientInvoiceDocument,
} from './InvoiceApi';
import {
  PAYMENT_METHODS,
  parseAmountMinor,
  parseRecipients,
  previewPayment,
} from './InvoiceFormRules';
import { InvoiceStateWord } from './InvoiceStateWord';

interface ActionProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly invoice: ClientInvoiceDocument;
  /** The API origin the print link points at; a test passes a fixed value. */
  readonly apiOrigin?: string | undefined;
}

const METHOD_WORDS: Record<string, readonly [string, string]> = {
  transfer: ['InvoicePayment.methodTransfer', 'Bank transfer'],
  cash: ['InvoicePayment.methodCash', 'Cash'],
  cheque: ['InvoicePayment.methodCheque', 'Cheque'],
  card_offline: ['InvoicePayment.methodCard', 'Card (taken offline)'],
};

function useRemember(organizationSlug: string) {
  const queryClient = useQueryClient();
  return (saved: ClientInvoiceDocument) => {
    queryClient.setQueryData(['client-invoice', organizationSlug, saved.id], saved);
    void queryClient.invalidateQueries({ queryKey: ['client-invoices', organizationSlug] });
    void queryClient.invalidateQueries({ queryKey: ['client-invoices-aging', organizationSlug] });
  };
}

/** The print view of this invoice in the reader's language (A4; "Save as PDF" from the dialog). */
export function InvoicePrintLink({
  organizationSlug,
  invoice,
  apiOrigin,
}: Omit<ActionProps, 'api'>) {
  const tOr = useTOr();
  const arabic = useActiveLocale().startsWith('ar');
  return (
    <a
      className="tm-inv-print-link"
      href={invoicePrintUrl(
        apiOrigin ?? apiBaseUrl(),
        organizationSlug,
        invoice.id,
        arabic ? 'ar' : 'en',
      )}
      target="_blank"
      rel="noreferrer"
    >
      {tOr('InvoiceSend.printView', 'Open the print view')}
    </a>
  );
}

/**
 * **Send invoice** (52-09) — a draft only. Issues the number and e-mails each recipient the link to
 * the invoice (`POST …/send`, `finance.manage`). One idempotency key per attempt makes a retry after
 * a lost answer return the first send; above the organization's threshold the API asks for a fresh
 * password and the refusal is shown as a sentence.
 */
export function InvoiceSendCard({ api, organizationSlug, invoice, apiOrigin }: ActionProps) {
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const remember = useRemember(organizationSlug);
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState(false);
  const [attemptKey, setAttemptKey] = useState<string>(() => crypto.randomUUID());

  const send = useMutation({
    mutationFn: (recipients: string[]) =>
      sendClientInvoice(
        api,
        organizationSlug,
        invoice.id,
        { to: recipients, message: message.trim() === '' ? null : message.trim() },
        attemptKey,
      ),
    onSuccess: (sent) => {
      remember(sent);
      setAttemptKey(crypto.randomUUID());
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const recipients = parseRecipients(to);
    setProblem(recipients === null);
    if (recipients !== null) send.mutate(recipients);
  };

  return (
    <form className="tm-card tm-stack" aria-labelledby="tm-inv-send" onSubmit={onSubmit} noValidate>
      <h2 id="tm-inv-send" className="tm-fin-card-title">
        {tOr('InvoiceSend.title', 'Send invoice')}
      </h2>
      <Field
        label={tOr('InvoiceSend.to', 'To')}
        type="text"
        inputMode="email"
        autoComplete="email"
        value={to}
        hint={tOr('InvoiceSend.toHint', 'Separate several addresses with commas')}
        error={
          problem
            ? tOr('InvoiceSend.problemTo', 'Enter 1 to 10 e-mail addresses, separated by commas.')
            : undefined
        }
        onChange={(event) => setTo(event.target.value)}
      />
      <Field
        label={tOr('InvoiceSend.message', 'Message')}
        value={message}
        maxLength={2000}
        onChange={(event) => setMessage(event.target.value)}
      />
      <InvoicePrintLink
        organizationSlug={organizationSlug}
        invoice={invoice}
        apiOrigin={apiOrigin}
      />
      <p className="tm-fin-muted">
        {tOr('InvoiceSend.mailNote', 'The e-mail carries a link to the invoice.')}
      </p>
      {invoice.lines.length === 0 ? (
        <InlineAlert tone="neutral">
          {tOr('InvoiceSend.needsLines', 'Add at least one line before sending.')}
        </InlineAlert>
      ) : null}
      {send.isError ? (
        <InlineAlert tone="danger" live>
          {describe(send.error)}
        </InlineAlert>
      ) : null}
      <div>
        <Button
          type="submit"
          tone="ink"
          disabled={invoice.lines.length === 0}
          loading={send.isPending}
          loadingLabel={tOr('InvoiceSend.sending', 'Sending')}
        >
          {tOr('InvoiceSend.send', 'Send invoice')}
        </Button>
      </div>
    </form>
  );
}

/**
 * **Record payment** (52-09) — a sent or part-paid invoice. Amount, date, method and reference go to
 * `POST …/payments` (`finance.manage`); a part payment leaves it part-paid, the payment that settles
 * the amount due moves it to paid. The form previews that with the API's own rule and refuses an
 * amount above what is due before the round trip.
 */
export function InvoicePaymentCard({ api, organizationSlug, invoice }: ActionProps) {
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const { money } = useDisplayFormatters();
  const remember = useRemember(organizationSlug);
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<string>('transfer');
  const [reference, setReference] = useState('');
  const [touched, setTouched] = useState(false);

  const preview = previewPayment(invoice, amount);
  const record = useMutation({
    mutationFn: (amountMinor: number) =>
      recordInvoicePayment(api, organizationSlug, invoice.id, {
        paidOn,
        amountMinor,
        method,
        reference: reference.trim() === '' ? null : reference.trim(),
      }),
    onSuccess: (saved) => {
      remember(saved);
      setAmount('');
      setReference('');
      setTouched(false);
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    const amountMinor = parseAmountMinor(amount, invoice.currency);
    if (!preview.ok || amountMinor === null || paidOn === '') return;
    record.mutate(amountMinor);
  };

  const amountError =
    touched && !preview.ok
      ? preview.error === 'overpayment'
        ? tOr('InvoicePayment.problemOver', 'This is more than the amount due.')
        : tOr('InvoicePayment.problemAmount', 'Enter an amount above 0.')
      : undefined;

  return (
    <form className="tm-card tm-stack" aria-labelledby="tm-inv-pay" onSubmit={onSubmit} noValidate>
      <h2 id="tm-inv-pay" className="tm-fin-card-title">
        {tOr('InvoicePayment.title', 'Record payment')}
      </h2>
      <div className="tm-fin-form">
        <Field
          label={`${tOr('InvoicePayment.amount', 'Amount')} (${invoice.currency})`}
          inputMode="decimal"
          value={amount}
          hint={`${tOr('InvoicePayment.upTo', 'Up to the amount due')}: ${money(invoice.amountDueMinor, invoice.currency)}`}
          error={amountError}
          onChange={(event) => setAmount(event.target.value)}
        />
        <Field
          label={tOr('InvoicePayment.paidOn', 'Paid on')}
          type="date"
          value={paidOn}
          onChange={(event) => setPaidOn(event.target.value)}
        />
        <Select
          label={tOr('InvoicePayment.method', 'Method')}
          value={method}
          onChange={(event) => setMethod(event.target.value)}
        >
          {PAYMENT_METHODS.map((entry) => (
            <option key={entry} value={entry}>
              {tOr(...METHOD_WORDS[entry]!)}
            </option>
          ))}
        </Select>
        <Field
          label={tOr('InvoicePayment.reference', 'Reference')}
          value={reference}
          maxLength={120}
          onChange={(event) => setReference(event.target.value)}
        />
      </div>
      {preview.ok && amount.trim() !== '' ? (
        <p className="tm-fin-muted" aria-live="polite">
          {tOr('InvoicePayment.after', 'After this payment')}:{' '}
          <InvoiceStateWord stateKey={preview.state} /> ·{' '}
          {money(preview.remainingMinor, invoice.currency)}
        </p>
      ) : null}
      {record.isError ? (
        <InlineAlert tone="danger" live>
          {describe(record.error)}
        </InlineAlert>
      ) : null}
      <div>
        <Button
          type="submit"
          tone="ink"
          loading={record.isPending}
          loadingLabel={tOr('InvoicePayment.saving', 'Saving')}
        >
          {tOr('InvoicePayment.record', 'Record payment')}
        </Button>
      </div>
    </form>
  );
}
