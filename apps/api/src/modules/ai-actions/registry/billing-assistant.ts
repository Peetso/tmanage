/**
 * AI action registry — the billing assistant's one new read (62-29, plan 62 §9).
 *
 * `client_invoices.pull_preview` (`read`/read) answers "what would this pull make of the draft?"
 * with the same plan as the pull itself (`ClientInvoicesService.pullPreview`), changing nothing. Its
 * total is the amount the 62-11 money card names for a pull and the member types back; the confirm
 * reads it again, so a draft whose approved time or expenses moved in between refuses the typed
 * amount. The route runs in-process as the member: `@RequireCapability('finance.manage')`, the
 * `client_invoicing` feature and the service's own `requireManage` all apply.
 */
import { z } from 'zod';
import type { AiActionOp } from './types.js';
import { bodyArgs, det, f, type AiActionDetail } from './detail.js';

const day = (): z.ZodString => z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'a date YYYY-MM-DD');
const yesNo = () => z.enum(['true', 'false']);

export const billingAssistantOps: readonly AiActionOp[] = [
  {
    id: 'client_invoices.pull_preview',
    method: 'GET',
    path: '/v1/organizations/:orgSlug/client-invoices/:invoiceId/pull-preview',
    capability: 'finance.manage',
    risk: 'read',
    scope: 'read',
  },
];

export const billingAssistantDetails: readonly AiActionDetail[] = [
  det({
    id: 'client_invoices.pull_preview',
    title: 'Preview a pull onto a draft',
    description:
      'What pulling approved time, billable expenses, the retainer or an accepted quote for a ' +
      'period would make of a draft invoice: its total before and after, the lines added and ' +
      'kept, and the time still waiting on approval. Changes nothing.',
    descriptionAr:
      'ما سينتج عن سحب الوقت المعتمد والمصروفات القابلة للفوترة أو عقد الاحتفاظ أو عرض سعر مقبول لفترة ' +
      'إلى مسودة فاتورة: الإجمالي قبل وبعد، والبنود المضافة والباقية، والوقت الذي ينتظر الاعتماد. لا يغيّر شيئاً.',
    input: bodyArgs(['invoiceId'], {
      from: day(),
      to: day(),
      time: z.enum(['false', 'by_task', 'by_person', 'by_day', 'single']).optional(),
      expenses: yesNo().optional(),
      retainer: yesNo().optional(),
      quoteId: f.id().optional(),
      depositPercent: f.int(1, 100).optional(),
    }),
    redact: 'finance',
    examples: [
      {
        summary: 'What would October time by task add to the draft?',
        args: { invoiceId: 'inv_42', from: '2026-10-01', to: '2026-10-31', time: 'by_task' },
      },
    ],
  }),
];
