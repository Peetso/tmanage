import { describe, expect, it } from 'vitest';
import { PLAN_IDS } from '../billing/plan-catalog.js';
import {
  CLIENT_MAX_FILE_BYTES,
  DEFAULT_PRESETS,
  classifyUpload,
  parsePresets,
  planMaxFileBytes,
  presetsToCsv,
  resolveScanSource,
  safetyChip,
} from './file-safety.js';
import type { ClassifyInput, FileTypePreset, UploadChannel } from './file-safety.js';
import { CONTRACT_MAX_SIZE_BYTES } from './upload-input.js';

/** 56-06 (R19-e) — the shared file-safety rule over a small corpus. */
const OOXML = 'application/vnd.openxmlformats-officedocument';
const PDF = Buffer.from('%PDF-1.7\n/JavaScript (app.alert(1))\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const ZIP = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('[Content_Types].xml'),
]);
const ZIP_VBA = Buffer.concat([ZIP, Buffer.from('word/vbaProject.bin')]);
const PE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]);
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07]);

function classify(
  fileName: string,
  declaredType: string,
  head: Buffer = Buffer.alloc(0),
  overrides: Partial<ClassifyInput> = {},
): ReturnType<typeof classifyUpload> {
  return classifyUpload({
    fileName,
    declaredType,
    head,
    sizeBytes: head.length || 10,
    channel: 'member' as UploadChannel,
    presets: DEFAULT_PRESETS,
    maxBytes: CONTRACT_MAX_SIZE_BYTES,
    ...overrides,
  });
}

const reason = (result: ReturnType<typeof classifyUpload>): string =>
  result.ok ? 'ok' : result.reason;

describe('classifyUpload — the corpus', () => {
  it.each([
    ['setup.exe', 'application/octet-stream', Buffer.alloc(0), 'executable'],
    ['report.pdf', 'application/pdf', PE, 'executable'],
    ['photo.png', 'image/png', ELF, 'executable'],
    ['tool.bin', 'application/octet-stream', MACHO, 'executable'],
    ['run.ps1', 'text/plain', Buffer.alloc(0), 'executable'],
    ['app.jar', 'application/java-archive', Buffer.alloc(0), 'executable'],
    ['brief.txt', 'application/javascript', Buffer.alloc(0), 'executable'],
    ['invoice.pdf.exe', 'application/pdf', Buffer.alloc(0), 'double_extension'],
    ['a.jpg .scr', 'image/jpeg', Buffer.alloc(0), 'double_extension'],
    ['setup.exe. . ', 'application/pdf', Buffer.alloc(0), 'executable'],
    ['photo.jpg.bin', 'image/jpeg', Buffer.alloc(0), 'double_extension'],
    ['budget.docm', `${OOXML}.wordprocessingml.document`, ZIP, 'macro_office'],
    ['budget.xlsx', 'application/vnd.ms-excel.sheet.macroEnabled.12', ZIP, 'macro_office'],
    ['budget.docx', `${OOXML}.wordprocessingml.document`, ZIP_VBA, 'macro_office'],
    ['bundle.zip', 'application/zip', ZIP, 'archive_off'],
    ['page.html', 'text/html', Buffer.alloc(0), 'ok'],
    ['legacy.doc', 'application/msword', Buffer.alloc(0), 'type_not_allowed'],
    ['plan.dwg', 'image/vnd.dwg', Buffer.from('AC1027', 'latin1'), 'ok'],
    ['plan.dwg', 'image/vnd.dwg', PDF, 'type_not_allowed'],
    ['plan.dxf', 'text/plain', Buffer.from('  0\nSECTION\n'), 'ok'],
    ['app.ts', 'text/plain', Buffer.from('export const a = 1;\n'), 'ok'],
    ['photo.png', 'image/png', PDF, 'type_not_allowed'],
    ['brief.docx', `${OOXML}.wordprocessingml.document`, ZIP, 'ok'],
    ['logo.svg', 'image/svg+xml', SVG, 'ok'],
    ['brief.pdf', 'application/pdf', PDF, 'ok'],
    ['brief.bin', 'application/pdf', PDF, 'ok'],
  ])('%s (%s) → %s', (name, type, head, expected) => {
    expect(reason(classify(name, type, head))).toBe(expected);
  });

  it('admits a zip once archives are switched on, and normalises the name it returns', () => {
    const presets: FileTypePreset[] = [...DEFAULT_PRESETS, 'archives'];
    expect(classify('bundle.zip', 'application/zip', ZIP, { presets })).toMatchObject({
      ok: true,
      family: 'archives',
    });
    expect(classify('‮plan.pdf. ', 'application/pdf', PDF)).toMatchObject({
      ok: true,
      normalizedName: 'plan.pdf',
    });
  });

  it('holds a public form to images and PDF, and inbound mail adds macro-free OOXML only', () => {
    const presets: FileTypePreset[] = [...DEFAULT_PRESETS, 'archives'];
    const form = { channel: 'public_form' as const, presets };
    const mail = { channel: 'inbound_mail' as const, presets };
    const docx = `${OOXML}.wordprocessingml.document`;
    expect(reason(classify('brief.docx', docx, ZIP, form))).toBe('channel_forbids');
    expect(reason(classify('bundle.zip', 'application/zip', ZIP, form))).toBe('channel_forbids');
    expect(reason(classify('logo.png', 'image/png', PNG, form))).toBe('ok');
    expect(reason(classify('brief.docx', docx, ZIP, mail))).toBe('ok');
    expect(reason(classify('brief.docx', docx, ZIP_VBA, mail))).toBe('macro_office');
    expect(reason(classify('bundle.zip', 'application/zip', ZIP, mail))).toBe('channel_forbids');
  });

  it('caps a client at 100 MB and anyone at the cap they are given', () => {
    const big = { sizeBytes: CLIENT_MAX_FILE_BYTES + 1 };
    expect(
      reason(classify('clip.mp4', 'video/mp4', undefined, { ...big, channel: 'client' })),
    ).toBe('too_large');
    expect(reason(classify('clip.mp4', 'video/mp4', undefined, big))).toBe('ok');
    expect(reason(classify('a.pdf', 'application/pdf', undefined, { maxBytes: 5 }))).toBe(
      'too_large',
    );
  });

  it('refuses a preset that is switched off', () => {
    const presets: FileTypePreset[] = ['documents'];
    expect(reason(classify('clip.mp4', 'video/mp4', undefined, { presets }))).toBe(
      'type_not_allowed',
    );
  });
});

describe('plan caps, stored presets and scan facts', () => {
  it('never lets a plan cap exceed the contract ceiling', () => {
    for (const plan of PLAN_IDS) {
      expect(planMaxFileBytes(plan)).toBeLessThanOrEqual(CONTRACT_MAX_SIZE_BYTES);
    }
    expect(planMaxFileBytes('free')).toBe(25 * 1024 * 1024);
    expect(planMaxFileBytes('pro')).toBe(planMaxFileBytes('studio'));
  });

  it('reads presets defensively and writes them in catalog order', () => {
    expect(parsePresets(undefined)).toEqual(DEFAULT_PRESETS);
    expect(parsePresets('nonsense')).toEqual(DEFAULT_PRESETS);
    expect(parsePresets('video, archives')).toEqual(['video', 'archives']);
    expect(presetsToCsv(['video', 'documents', 'video'])).toBe('documents,video');
  });

  it('says tmanage only for a real engine, and chips a clean verdict only', () => {
    expect(resolveScanSource({ scanner: 'clamav' })).toBe('tmanage');
    expect(resolveScanSource({ scanner: 'stub' })).toBe('none');
    expect(resolveScanSource({ scanner: null })).toBe('none');
    expect(resolveScanSource({ scanner: 'clamav', storedAt: 'provider/x' })).toBe('provider');
    expect(safetyChip({ scanSource: 'tmanage', scanVerdict: 'clean' })).toBe('scanned_tmanage');
    expect(safetyChip({ scanSource: 'tmanage', scanVerdict: 'infected' })).toBe('not_scanned');
    expect(safetyChip({ scanSource: null, scanner: 'clamav', scanVerdict: 'clean' })).toBe(
      'scanned_tmanage',
    );
    expect(safetyChip({ scanSource: 'none', scanVerdict: 'unscanned' })).toBe('not_scanned');
  });
});
