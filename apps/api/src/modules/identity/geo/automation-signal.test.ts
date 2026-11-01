import { expect, it } from 'vitest';
import { parseClientSignals as parse, scoreAutomation as score } from './automation-signal.js';
import { verdictOf } from './automation-signal.js';

const person = {
  ...{ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', clientHints: null },
  ...{ acceptLanguage: 'en', client: { formMs: 1500, keystrokes: 30 } },
  ...{ hostingIp: false, torIp: false, recentAttemptsFromIp: 4 },
};
const bot = {
  ...{ userAgent: 'HeadlessChrome/1', clientHints: 'HeadlessChrome', acceptLanguage: '' },
  ...{ client: { webdriver: true, formMs: 1499, keystrokes: 0 } },
  ...{ hostingIp: true, torIp: true, recentAttemptsFromIp: 5 },
};

it('R12 automation: every reason weighed, capped at 100; a person at the thresholds scores 0', () => {
  expect(score(person)).toEqual({ score: 0, verdict: 'likely_person', reasons: [] });
  const all = score(bot);
  const head = 'ua_headless,ch_headless,webdriver,form_too_fast,no_keystrokes,hosting_ip';
  expect(all.reasons.join()).toBe(`${head},tor_ip,rate_high,accept_language_missing`);
  const curl = score({ ...person, userAgent: 'curl/8' }).reasons;
  expect([all.score, curl]).toEqual([100, ['ua_tool']]);
  const verdicts = [24, 25, 59, 60].map(verdictOf).join();
  expect(verdicts).toBe('likely_person,unclear,unclear,likely_automated');
});

it('R12 automation: bad client fields are dropped, never refused', () => {
  const bad = { webdriver: 'y', formMs: -1, keystrokes: 1.5, hints: 'h'.repeat(256) };
  expect([parse('x'), parse(bad)]).toEqual([null, null]);
  const odd = parse({ webdriver: true, formMs: 3_600_001, keystrokes: 3 });
  expect(odd).toEqual({ webdriver: true, keystrokes: 3 });
});
