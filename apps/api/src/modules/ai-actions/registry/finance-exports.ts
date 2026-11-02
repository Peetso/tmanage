/**
 * AI action registry — 52-11 (R19-b) accounting export history: the one read op's detail. The
 * export itself (`POST …/finance/exports`) is NEVER (`never.ts`, `finance_settings`): it is a
 * step-up mass egress of the books.
 */
import { det, noArgs, type AiActionDetail } from './detail.js';

export const financeExportDetails: readonly AiActionDetail[] = [
  det({
    id: 'finance.exports.list',
    redact: 'finance',
    notifies: false,
    title: 'List accounting exports',
    description:
      'The newest 50 accounting exports: target system, period, what was exported, record counts, ' +
      'the manifest SHA-256, who ran it and when. No file content.',
    descriptionAr:
      'آخر 50 تصديراً محاسبياً: النظام المستهدف والفترة وما صُدّر وعدد السجلات وبصمة الملف ومن نفّذه ' +
      'ومتى. بدون محتوى الملفات.',
    input: noArgs(),
    examples: [
      { summary: 'When did we last export invoices to Zoho?', args: {} },
      { summary: 'Show the accounting export history', args: {} },
    ],
  }),
];
