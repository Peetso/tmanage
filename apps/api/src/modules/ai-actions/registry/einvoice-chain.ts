/**
 * AI action registry — 52-12 (R22-b) e-invoice chain verdict: the one read op's detail. The
 * verdict is written by the worker's nightly reconciler; no route changes it.
 */
import { det, noArgs, type AiActionDetail } from './detail.js';

export const einvoiceChainDetails: readonly AiActionDetail[] = [
  det({
    id: 'finance.einvoicing.chain.get',
    redact: 'finance',
    notifies: false,
    title: 'Show the e-invoice chain check',
    description:
      "The newest nightly check of the organization's e-invoice hash chain (invoices and credit " +
      'notes): ok, broken or empty, when it ran, the last counter value, how many documents it ' +
      'walked and, when broken, where and why. No hashes, no amounts.',
    descriptionAr:
      'آخر فحص ليلي لسلسلة تجزئة الفواتير الإلكترونية (الفواتير وإشعارات الدائن): سليمة أو مكسورة ' +
      'أو فارغة، ووقت الفحص، وآخر قيمة للعداد، وعدد المستندات، وعند الكسر موضعه وسببه. بدون ' +
      'بصمات أو مبالغ.',
    input: noArgs(),
    examples: [
      { summary: 'Is our e-invoice chain intact?', args: {} },
      { summary: 'When was the invoice chain last checked?', args: {} },
    ],
  }),
];
