/**
 * 52-11 — one export run: the requested kinds of one target, rendered through the one CSV writer
 * (`toCsv`, 52-29: UTF-8 BOM, CRLF, formula guard), plus the bilingual README. Pure; the API wraps
 * the result in a STORE zip with `manifest.json`.
 */

import { toCsv } from '../../export/csv.js';
import { makeFormatter } from './columns.js';
import { GENERIC, validateGeneric } from './generic.js';
import { ODOO, validateOdoo } from './odoo.js';
import { QOYOD, validateQoyod } from './qoyod.js';
import { QUICKBOOKS, validateQuickbooks } from './quickbooks.js';
import { WAFEQ, validateWafeq } from './wafeq.js';
import { XERO, validateXero } from './xero.js';
import { ZOHO_BOOKS, validateZohoBooks } from './zoho-books.js';
import { EXPORT_KINDS } from './types.js';
import type { ExportFile, ExportInput, ExportKind, ExportTarget, TargetMap } from './types.js';

export const TARGET_MAPS: Readonly<Record<ExportTarget, TargetMap>> = {
  zoho_books: ZOHO_BOOKS,
  odoo: ODOO,
  qoyod: QOYOD,
  wafeq: WAFEQ,
  quickbooks: QUICKBOOKS,
  xero: XERO,
  generic: GENERIC,
};

export const TARGET_VALIDATORS: Readonly<
  Record<ExportTarget, (files: readonly ExportFile[]) => string[]>
> = {
  zoho_books: validateZohoBooks,
  odoo: validateOdoo,
  qoyod: validateQoyod,
  wafeq: validateWafeq,
  quickbooks: validateQuickbooks,
  xero: validateXero,
  generic: validateGeneric,
};

export interface BuildExportInput extends ExportInput {
  readonly target: ExportTarget;
  readonly kinds: readonly ExportKind[];
  readonly latinOnly?: boolean;
  /** The period, for the README (ISO dates). */
  readonly periodStart?: string;
  readonly periodEnd?: string;
}

export interface BuiltExport {
  /** The CSV files, one per requested kind, in {@link EXPORT_KINDS} order. */
  readonly files: readonly ExportFile[];
  readonly readme: ExportFile;
  /** Records (not lines) per requested kind. */
  readonly rowCounts: Readonly<Partial<Record<ExportKind, number>>>;
}

function countOf(input: ExportInput, kind: ExportKind): number {
  switch (kind) {
    case 'invoices':
      return input.invoices.length;
    case 'credit_notes':
      return input.creditNotes.length;
    case 'payments':
      return input.payments.length;
    case 'customers':
      return input.customers.length;
    default:
      return input.expenses.length;
  }
}

const PERSONAL_DATA_EN: Readonly<Record<ExportKind, string>> = {
  invoices: 'invoices: the customer company name (and, for Xero, its billing e-mail and address)',
  credit_notes: 'credit notes: the customer company name',
  payments: 'payments: the customer company name and the payment reference',
  customers:
    'customers: company names, tax registration numbers, billing addresses and billing e-mails',
  expenses: 'expenses: the display name of the person who submitted each expense',
};

const PERSONAL_DATA_AR: Readonly<Record<ExportKind, string>> = {
  invoices: 'الفواتير: اسم شركة العميل (ومع Xero بريد الفوترة وعنوانها)',
  credit_notes: 'الإشعارات الدائنة: اسم شركة العميل',
  payments: 'المدفوعات: اسم شركة العميل ومرجع الدفعة',
  customers: 'العملاء: أسماء الشركات وأرقام التسجيل الضريبي وعناوين وبريد الفوترة',
  expenses: 'المصروفات: الاسم الظاهر لمن قدّم كل مصروف',
};

function readmeOf(
  map: TargetMap,
  kinds: readonly ExportKind[],
  files: readonly ExportFile[],
  input: BuildExportInput,
): ExportFile {
  const period =
    input.periodStart !== undefined && input.periodEnd !== undefined
      ? `${input.periodStart} .. ${input.periodEnd}`
      : '';
  const names = files.map((file) => `  ${file.name}`).join('\r\n');
  const en = [
    `TManage accounting export for ${map.label}${period ? ` (${period})` : ''}`,
    '',
    map.readme.en,
    '',
    'Files:',
    names,
    '  manifest.json (SHA-256 of every file)',
    '',
    'Personal data in this export:',
    ...kinds.map((kind) => `  - ${PERSONAL_DATA_EN[kind]}`),
    'Keep the file where only your accountants can open it and delete it after the import.',
    'No cost rates, member costs or internal notes are included.',
    '',
    `Column map verified against the ${map.label} import template dated ${map.templateCheckedOn} (checked with TManage's fixture validator, not yet by an import into a ${map.label} sandbox).`,
    `Files are UTF-8 with BOM, comma separated, CRLF line ends.${input.latinOnly === true ? ' Arabic text was removed (Latin-only export).' : ''}`,
  ].join('\r\n');
  const ar = [
    `تصدير محاسبي من TManage إلى ${map.label}${period ? ` (${period})` : ''}`,
    '',
    map.readme.ar,
    '',
    'الملفات:',
    names,
    '  manifest.json (بصمة SHA-256 لكل ملف)',
    '',
    'البيانات الشخصية في هذا التصدير:',
    ...kinds.map((kind) => `  - ${PERSONAL_DATA_AR[kind]}`),
    'احفظ الملف حيث لا يفتحه إلا محاسبوك واحذفه بعد الاستيراد.',
    'لا يتضمن أسعار التكلفة أو تكاليف الأعضاء أو الملاحظات الداخلية.',
    '',
    `خريطة الأعمدة مطابقة لقالب الاستيراد في ${map.label} بتاريخ ${map.templateCheckedOn} (تم التحقق بأداة TManage، وليس باستيراد فعلي في حساب تجريبي).`,
    `الملفات بترميز UTF-8 مع BOM، مفصولة بفواصل.${input.latinOnly === true ? ' أزيل النص العربي (تصدير بأحرف لاتينية فقط).' : ''}`,
  ].join('\r\n');
  return {
    name: `README-${map.target}.txt`,
    text: `\uFEFF${en}\r\n\r\n----------------------------------------\r\n\r\n${ar}\r\n`,
  };
}

/**
 * Render one export. Kinds are de-duplicated and emitted in {@link EXPORT_KINDS} order; `latinOnly`
 * strips Arabic from the description columns and blanks the Arabic-only ones.
 */
export function buildExport(input: BuildExportInput): BuiltExport {
  const map = TARGET_MAPS[input.target];
  const kinds = EXPORT_KINDS.filter((kind) => input.kinds.includes(kind));
  const f = makeFormatter(map, input.latinOnly === true);
  const files: ExportFile[] = [];
  const rowCounts: Partial<Record<ExportKind, number>> = {};
  for (const kind of kinds) {
    const spec = map.files.find((file) => file.kind === kind);
    if (spec === undefined) continue;
    files.push({ name: spec.name, text: toCsv(spec.rows(input, f), spec.header, { bom: true }) });
    rowCounts[kind] = countOf(input, kind);
  }
  return { files, readme: readmeOf(map, kinds, files, input), rowCounts };
}
