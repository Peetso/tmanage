import { describe, expect, it } from 'vitest';
import { toCsv } from '../export/csv.js';
import {
  CONTACT_ERROR_REPORT_HEADER,
  contactErrorReportRows,
  contactsCsvHeader,
  isValidContactMapping,
  parseContactsCsv,
  parseVcard,
} from './contacts.js';
import type { ContactRecord } from './contacts.js';

describe('54-11 contacts parsers', () => {
  it('reads a Google CSV with a BOM, CRLF, quoted cells and an Arabic name', () => {
    const csv =
      '\uFEFFName,E-mail 1 - Value,Organization 1 - Name\r\n"سارة أحمد",Sara@Example.COM ::: x@y.com,"Nile, Co"\r\nNo Mail,,X\r\nDup,sara@example.com,\r\n';
    const result = parseContactsCsv(csv);
    expect(result.contacts).toEqual([
      { displayName: 'سارة أحمد', email: 'sara@example.com', company: 'Nile, Co' },
    ]);
    expect(result.reasons).toMatchObject({ missing_email: 1, duplicate: 1 });
  });

  it('reads an Outlook CSV (first/last name) and a generic email column', () => {
    const outlook = parseContactsCsv(
      'First Name,Last Name,E-mail Address,Company\nOmar,Ali,omar@x.io,Acme\nBad,Row,not-an-email,\n',
    );
    expect(outlook.contacts).toEqual([
      { displayName: 'Omar Ali', email: 'omar@x.io', company: 'Acme' },
    ]);
    expect(outlook.reasons.invalid_email).toBe(1);
    expect(parseContactsCsv('EMAIL\nz@z.co\n').contacts[0]?.email).toBe('z@z.co');
  });

  it('caps at 5,000 records and counts the rest as skipped', () => {
    const rows = Array.from({ length: 5_001 }, (_, i) => `u${i}@x.io`).join('\n');
    const result = parseContactsCsv(`email\n${rows}`);
    expect([result.contacts.length, result.skipped, result.reasons.over_limit]).toEqual([
      5_000, 1, 1,
    ]);
  });

  it('reads vCard folded lines, N when FN is missing, and skips QUOTED-PRINTABLE values', () => {
    const vcf =
      'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Layla\r\n  Hassan\r\nitem1.EMAIL;TYPE=INTERNET:Layla@X.io\r\nEMAIL:other@x.io\r\nORG:Studio;Design\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:4.0\r\nN:Nour;Mona;;;\r\nFN;ENCODING=QUOTED-PRINTABLE:=D8=A8\r\nEMAIL:mona@x.io\r\nEND:VCARD\r\n';
    const result = parseVcard(vcf);
    expect(result.contacts).toEqual([
      { displayName: 'Layla Hassan', email: 'layla@x.io', company: 'Studio' },
      { displayName: 'Mona Nour', email: 'mona@x.io', company: null },
    ]);
    expect(result.reasons.quoted_printable).toBe(1);
  });

  it('r46: a chosen column mapping wins over the guess; the trace marks duplicates by e-mail', () => {
    const csv = [
      'Who,Work mail,Home mail,Firm',
      'Sara,sara@a.co,s@home.co,Acme',
      'Sara 2,SARA@A.CO,,Acme',
      'No,,x@y.co,',
    ].join('\n');
    expect(contactsCsvHeader(csv).header).toEqual(['Who', 'Work mail', 'Home mail', 'Firm']);
    const trace: ContactRecord[] = [];
    const mapped = parseContactsCsv(csv, { email: 1, name: 0, company: 3 }, trace);
    expect(mapped.contacts).toEqual([{ displayName: 'Sara', email: 'sara@a.co', company: 'Acme' }]);
    expect(trace.map((r) => [r.line, r.outcome])).toEqual([
      [2, 'ok'],
      [3, 'duplicate'],
      [4, 'missing_email'],
    ]);
    expect(isValidContactMapping({ email: 4, name: null, company: null }, 4)).toBe(false);
    expect(isValidContactMapping({ email: 2, name: null, company: 3 }, 4)).toBe(true);
  });

  it('r46: the error report lists only rejected rows and neutralises formulas', () => {
    const trace: ContactRecord[] = [];
    const vcf = [
      'BEGIN:VCARD',
      'FN:=HYPERLINK("x")',
      'EMAIL:bad@',
      'END:VCARD',
      'BEGIN:VCARD',
      'EMAIL:a@b.co',
      'END:VCARD',
    ].join('\n');
    parseVcard(vcf, trace);
    const rows = contactErrorReportRows(trace);
    expect(rows).toEqual([[1, '=HYPERLINK("x")', 'bad@', null, 'Not a valid e-mail address']]);
    // The screen serialises exactly like this: the `=` cell comes out as quoted text.
    const csv = toCsv(rows, CONTACT_ERROR_REPORT_HEADER, { bom: true });
    expect(csv.startsWith('\uFEFFRow,Name,E-mail,Company,Problem\r\n')).toBe(true);
    expect(csv.split('\r\n')[1]).toBe(`1,"'=HYPERLINK(""x"")",bad@,,Not a valid e-mail address`);
  });
});
