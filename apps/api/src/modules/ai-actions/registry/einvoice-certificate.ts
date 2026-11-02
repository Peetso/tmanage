/**
 * AI action registry — 52-12 (R22-a) the ZATCA signing certificate: the one status read op's
 * detail. The op can never return a key: the route answers public facts only (issuer, validity,
 * fingerprint, sandbox) and the result is `finance`-redacted. Storing, replacing and revoking the
 * certificate are NEVER (`never.ts`, `finance_settings`).
 */
import { det, noArgs, type AiActionDetail } from './detail.js';

export const einvoiceCertificateDetails: readonly AiActionDetail[] = [
  det({
    id: 'finance.einvoicing.certificate.get',
    redact: 'finance',
    notifies: false,
    title: 'Show the e-invoice signing certificate status',
    description:
      "The status of the organization's ZATCA signing certificate: active, who issued it, when " +
      'it is valid, its fingerprint and whether it is a test (sandbox) certificate. Never a key.',
    descriptionAr:
      'حالة شهادة توقيع الفواتير الإلكترونية (زاتكا) للمؤسسة: الجهة المُصدِرة وفترة الصلاحية ' +
      'والبصمة وما إذا كانت شهادة اختبار. لا يُعرض أي مفتاح.',
    input: noArgs(),
    examples: [
      { summary: 'Is our ZATCA certificate still valid?', args: {} },
      { summary: 'Are we signing invoices with a test certificate?', args: {} },
    ],
  }),
];
