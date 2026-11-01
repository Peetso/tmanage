import { describe, expect, it } from 'vitest';
import { summarizeUserAgent } from './user-agent-summary.js';

const AGENTS: [string, string][] = [
  ['Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/130.0.0.0 Safari/537.36', 'Chrome Windows desktop'],
  [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) Version/17.5 Mobile/15E148 Safari/604',
    'Safari iOS phone',
  ],
  [
    'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/130.0 Safari/537.36',
    'Headless Chrome Linux bot',
  ],
  ['curl/8.4.0', 'curl null bot'],
  ['', 'null null unknown'],
];

describe('R12 user-agent summary', () => {
  it.each(AGENTS)('%s', (ua, expected) => {
    const { browser, os, deviceType } = summarizeUserAgent(ua);
    expect(`${browser} ${os} ${deviceType}`).toBe(expected);
  });
});
