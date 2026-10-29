import { expect, test } from 'vitest';

import { lintCatalogs } from './copy-lint.mjs';

const glossary = {
  brands: ['Google'],
  forbidden: [{ en: 'tenant', use: 'organization' }],
  jargon: [],
  terms: [{ en: 'project', ar: 'مشروع', accept: ['مشروع'], lint: true }],
};
const en = { a: 'Your tenant', b: 'Open {n}', c: 'Save', d: 'Google', e: 'New project', f: 'Hi' };
const ar = { a: 'مؤسستك', b: 'افتح {x}', c: 'Save', d: 'Google', e: 'مهمة جديدة', g: 'زائد' };

test('errors, warnings and the baseline', () => {
  const r = lintCatalogs({ en, ar, glossary, baseline: ['forbidden-term|a', 'missing-key|zz'] });
  const ids = (list) => list.map((f) => `${f.rule}|${f.key}`).sort();
  expect(ids(r.errors)).toEqual([
    'missing-key|f',
    'missing-key|g',
    'placeholder|b',
    'untranslated-ar|c',
  ]);
  expect(ids(r.warnings)).toEqual(['glossary|e', 'placeholder-dropped|b']);
  expect(ids(r.baselined)).toEqual(['forbidden-term|a']);
  expect(r.stale).toEqual(['missing-key|zz']);
});
