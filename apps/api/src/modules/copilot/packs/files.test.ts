import { describe, expect, it } from 'vitest';
import {
  LOW_TEXT_MAX_CHARS,
  MEDIUM_TEXT_MAX_CHARS,
  SCAN_TIER,
  fileReadOf,
  offersSummary,
  planFileQuestion,
  textTierOf,
  type FileRead,
} from './files.js';

/** 62-25 — the tier of a file question is decided by the file, never by the model. */

function read(overrides: Partial<FileRead> = {}): FileRead {
  return {
    fileId: 'f1',
    fileName: 'Contract.pdf',
    href: '/files/f1',
    audience: 'internal',
    status: 'ready',
    reasonCode: null,
    chars: 10,
    pages: 1,
    truncated: false,
    textId: 't1',
    summary: null,
    text: 'Short text',
    textCut: false,
    passages: [],
    ...overrides,
  };
}

describe('file question plan (62-25)', () => {
  it('sizes the text into Low, Medium and Medium-High', () => {
    expect(textTierOf(LOW_TEXT_MAX_CHARS)).toBe('low');
    expect(textTierOf(LOW_TEXT_MAX_CHARS + 1)).toBe('medium');
    expect(textTierOf(MEDIUM_TEXT_MAX_CHARS)).toBe('medium');
    expect(textTierOf(MEDIUM_TEXT_MAX_CHARS + 1)).toBe('medium_high');
  });

  it('a saved summary is always Low, even for a scan or a long file', () => {
    for (const status of ['ready', 'scan_only'] as const) {
      expect(planFileQuestion(read({ status, summary: 'S.' }), null)).toEqual({
        kind: 'answer',
        tier: 'low',
        mode: 'summary',
      });
    }
  });

  it('a scan is read only with the scan accepted at its tier', () => {
    const scan = read({ status: 'scan_only', text: null });
    expect(planFileQuestion(scan, null)).toEqual({ kind: 'estimate', tier: SCAN_TIER, scan: true });
    expect(planFileQuestion(scan, { tier: 'medium_high', scan: false }).kind).toBe('estimate');
    expect(planFileQuestion(scan, { tier: 'high', scan: true })).toEqual({
      kind: 'scan',
      tier: SCAN_TIER,
    });
  });

  it('a long text asks first; an accepted higher tier is kept; an accepted scan is no text accept', () => {
    const long = read({ text: 'x'.repeat(MEDIUM_TEXT_MAX_CHARS + 1) });
    expect(planFileQuestion(long, null)).toEqual({
      kind: 'estimate',
      tier: 'medium_high',
      scan: false,
    });
    expect(planFileQuestion(long, { tier: 'medium_high', scan: true }).kind).toBe('estimate');
    expect(planFileQuestion(long, { tier: 'high', scan: false })).toEqual({
      kind: 'answer',
      tier: 'high',
      mode: 'text',
    });
    expect(planFileQuestion(read(), { tier: 'medium_high', scan: false }).tier).toBe('medium_high');
  });

  it('offers the summary tool only when the model reads the whole file and none is saved', () => {
    expect(offersSummary(read(), planFileQuestion(read(), null))).toBe(true);
    const pending = read({ status: 'pending', text: null });
    expect(offersSummary(pending, planFileQuestion(pending, null))).toBe(false);
    const noRow = read({ textId: null });
    expect(offersSummary(noRow, planFileQuestion(noRow, null))).toBe(false);
  });

  it('reads the route view, and nothing else, as a file', () => {
    expect(
      fileReadOf({ data: { fileId: 'f1', status: 'ready', audience: 'internal' } }),
    ).toMatchObject({
      fileId: 'f1',
      href: '/files/f1',
    });
    expect(fileReadOf({ fileId: 'f1', status: 'gone', audience: 'internal' })).toBeNull();
    expect(fileReadOf({ fileId: 'f1', status: 'ready', audience: 'public' })).toBeNull();
    expect(fileReadOf('not json')).toBeNull();
  });
});
