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

test('term-clash: one Arabic word per thing (WX1)', () => {
  const g = {
    brands: [],
    forbidden: [],
    jargon: [],
    terms: [
      { en: 'work', ar: 'العمل', accept: ['عمل', 'مهام'], lint: false, avoid: ['شغل'] },
      { en: 'milestone', ar: 'محطة', accept: ['محطه'], lint: false, avoid: ['مرحل', 'مراحل'] },
      { en: 'phase', ar: 'مرحلة رئيسية', accept: ['مرحل', 'مراحل'], lint: false },
    ],
  };
  const e = {
    w1: 'All work',
    w2: 'All work',
    m1: 'Milestones',
    m2: 'Milestones',
    m3: 'Group milestones into phases',
    s: 'Stages',
  };
  const a = {
    w1: 'كل الشغل',
    w2: 'كل المهام',
    m1: 'المراحل',
    m2: 'المحطات',
    m3: 'قسّم المحطات إلى مراحل رئيسية',
    s: 'المراحل',
  };
  const r = lintCatalogs({ en: e, ar: a, glossary: g });
  const clashes = r.errors.filter((f) => f.rule === 'term-clash').map((f) => f.key);
  // «الشغل» for work and «المراحل» (the stage word) for milestones fail; a phase owns «مراحل».
  expect(clashes.sort()).toEqual(['m1', 'w1']);
});
