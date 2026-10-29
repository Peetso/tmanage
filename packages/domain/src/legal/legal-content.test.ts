import { describe, expect, it } from 'vitest';
import {
  LEGAL_COPY_AR,
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENTS_AR,
  LEGAL_DOCUMENTS_BY_LOCALE,
  LEGAL_EFFECTIVE_DATE,
  OPERATOR_ACCESS_CLAUSE,
  OPERATOR_ACCESS_SECTION_ID,
  legalDocumentFor,
  legalLocaleOf,
} from './legal-content.js';
import type { LegalDocumentKey } from './legal-content.js';

/** platform-admin v2 · PA-03 — the legal documents in both locales, with the operator clause. */

const KEYS: readonly LegalDocumentKey[] = ['terms', 'privacy'];
const RLM = '‏';
const ARABIC = /[؀-ۿ]/u;
const LATIN_OR_DIGIT = /[A-Za-z0-9]/u;

describe('legal documents (EN + AR)', () => {
  it('publish both documents in English and Arabic with the same sections in the same order', () => {
    for (const key of KEYS) {
      const en = LEGAL_DOCUMENTS[key];
      const ar = LEGAL_DOCUMENTS_AR[key];
      expect(ar.doc).toBe(key);
      expect(ar.sections.map((s) => s.id)).toEqual(en.sections.map((s) => s.id));
      expect(ARABIC.test(ar.title)).toBe(true);
      // Every English section has an Arabic translation — none falls back to English.
      for (const section of en.sections) {
        expect(Object.keys(LEGAL_COPY_AR[key].sections), `${key}.${section.id}`).toContain(
          section.id,
        );
      }
    }
  });

  it('carry the operator-access section in both documents and both locales, verbatim', () => {
    for (const key of KEYS) {
      const en = LEGAL_DOCUMENTS[key].sections.find((s) => s.id === OPERATOR_ACCESS_SECTION_ID);
      const ar = LEGAL_DOCUMENTS_AR[key].sections.find((s) => s.id === OPERATOR_ACCESS_SECTION_ID);
      expect(en?.heading).toBe('Operator access for support, safety and legal reasons');
      expect(en?.body).toBe(OPERATOR_ACCESS_CLAUSE.en.body);
      expect(en?.body).toContain('requires a fresh identity confirmation');
      expect(en?.body).toContain('Organization owners can see these entries in their audit log.');
      expect(ar?.heading).toBe('وصول المشغّل لأغراض الدعم والسلامة والالتزامات القانونية');
      expect(ar?.body).toBe(OPERATOR_ACCESS_CLAUSE.ar.body);
      expect(ar?.body).toContain('ويمكن لمالكي المنظمة رؤية هذه السجلات في سجل التدقيق الخاص بهم.');
    }
  });

  it('bump the effective date to 2026-10-28 in both documents and both intros', () => {
    expect(LEGAL_EFFECTIVE_DATE).toBe('2026-10-28');
    for (const key of KEYS) {
      expect(LEGAL_DOCUMENTS[key].effectiveDate).toBe('2026-10-28');
      expect(LEGAL_DOCUMENTS_AR[key].effectiveDate).toBe('2026-10-28');
      expect(LEGAL_DOCUMENTS[key].intro).toMatch(/^Last updated: 28 October 2026\./u);
      expect(LEGAL_DOCUMENTS_AR[key].intro).toContain('28 أكتوبر 2026');
    }
  });

  it('start the Arabic strings this slice wrote that mix Latin or digits with U+200F', () => {
    const mixed = [
      OPERATOR_ACCESS_CLAUSE.ar.body,
      LEGAL_DOCUMENTS_AR.terms.intro,
      LEGAL_DOCUMENTS_AR.privacy.intro,
    ];
    for (const text of mixed) {
      expect(LATIN_OR_DIGIT.test(text)).toBe(true);
      expect(text.startsWith(RLM)).toBe(true);
    }
    // The heading has no Latin and needs no mark.
    expect(LATIN_OR_DIGIT.test(OPERATOR_ACCESS_CLAUSE.ar.heading)).toBe(false);
  });

  it('answer by locale, English for everything but Arabic', () => {
    expect(legalLocaleOf('ar-EG')).toBe('ar');
    expect(legalLocaleOf('AR')).toBe('ar');
    expect(legalLocaleOf('en-GB')).toBe('en');
    expect(legalLocaleOf('fr')).toBe('en');
    expect(legalLocaleOf(undefined)).toBe('en');
    expect(legalDocumentFor('privacy', 'ar-EG')).toBe(LEGAL_DOCUMENTS_AR.privacy);
    expect(legalDocumentFor('terms', 'en')).toBe(LEGAL_DOCUMENTS.terms);
    expect(LEGAL_DOCUMENTS_BY_LOCALE.en).toBe(LEGAL_DOCUMENTS);
    expect(LEGAL_DOCUMENTS_BY_LOCALE.ar).toBe(LEGAL_DOCUMENTS_AR);
  });

  it('stay frozen so the payload is deterministic', () => {
    expect(Object.isFrozen(LEGAL_DOCUMENTS_AR)).toBe(true);
    expect(Object.isFrozen(LEGAL_DOCUMENTS_AR.privacy.sections)).toBe(true);
    expect(Object.isFrozen(LEGAL_DOCUMENTS.privacy.sections)).toBe(true);
  });
});
