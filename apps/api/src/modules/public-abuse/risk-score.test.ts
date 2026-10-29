import { describe, expect, it } from 'vitest';
import {
  RISK_WEIGHTS,
  countUrls,
  decisionFor,
  isDisposableDomain,
  isLanguageMismatch,
  parseDomainList,
  scoreRisk,
} from './risk-score.js';
import type { RiskFacts, RiskSignal } from './risk-score.js';

/** UNIT-52-25 — one fixture per signal, and the three decision bands. */

const clean: RiskFacts = {
  honeypotFilled: false,
  fillMs: 12_000,
  jsProofValid: true,
  disposableDomain: false,
  urlCount: 0,
  repeatedWithin24h: false,
  ipSubmissionsToday: 1,
  languageMismatch: false,
};

describe('scoreRisk', () => {
  it('scores a clean human submission 0 and allows it', () => {
    expect(scoreRisk(clean)).toEqual({ score: 0, reasons: [], decision: 'allow' });
  });

  const fixtures: [RiskSignal, Partial<RiskFacts>][] = [
    ['honeypot', { honeypotFilled: true }],
    ['fast_fill', { fillMs: 2_999 }],
    ['no_js_proof', { jsProofValid: false }],
    ['disposable_domain', { disposableDomain: true }],
    ['many_urls', { urlCount: 4 }],
    ['repeated_values', { repeatedWithin24h: true }],
    ['ip_daily_volume', { ipSubmissionsToday: 11 }],
    ['language_mismatch', { languageMismatch: true }],
  ];
  it.each(fixtures)('adds the %s weight exactly', (signal, change) => {
    const result = scoreRisk({ ...clean, ...change });
    expect(result.reasons).toEqual([signal]);
    expect(result.score).toBe(RISK_WEIGHTS[signal]);
  });

  it('draws the bands at 30 and 70', () => {
    expect([29, 30, 69, 70].map(decisionFor)).toEqual(['allow', 'hold', 'hold', 'spam']);
    // A script that never ran the page and filled in a hurry.
    expect(scoreRisk({ ...clean, jsProofValid: false, fillMs: 500 }).decision).toBe('spam');
    // An unknown fill time is not a fast fill; 3 URLs is not "more than 3".
    expect(scoreRisk({ ...clean, fillMs: undefined, urlCount: 3 }).score).toBe(0);
  });

  it('widens the per-IP threshold by the e2e limit scale', () => {
    expect(scoreRisk({ ...clean, ipSubmissionsToday: 500, ipThresholdScale: 1000 }).score).toBe(0);
  });
});

describe('the signal helpers', () => {
  it('counts URLs across fields', () => {
    expect(countUrls(['see https://a.example and www.b.example', undefined, 'http://c'])).toBe(3);
  });

  it('matches a disposable domain and its subdomains, not look-alikes', () => {
    const list = parseDomainList('# comment\nmailinator.com\n\nYOPMAIL.com\n');
    expect(isDisposableDomain('mailinator.com', list)).toBe(true);
    expect(isDisposableDomain('x.yopmail.com', list)).toBe(true);
    expect(isDisposableDomain('notmailinator.com', list)).toBe(false);
  });

  it('flags a language mismatch only on evidence', () => {
    expect(isLanguageMismatch('ar-EG,ar;q=0.9', 'en')).toBe(true);
    expect(isLanguageMismatch('en-US,en;q=0.9', 'en')).toBe(false);
    expect(isLanguageMismatch(undefined, 'en')).toBe(false);
    expect(isLanguageMismatch('*', 'ar')).toBe(false);
  });
});
