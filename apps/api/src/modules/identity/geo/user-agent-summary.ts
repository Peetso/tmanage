/**
 * R12 (R1). Browser, operating system and device type from a `User-Agent`, by regex only — no
 * dependency, nothing stored (computed at read time). A best guess, shown beside the raw string.
 */
export type DeviceType = 'desktop' | 'phone' | 'tablet' | 'bot' | 'unknown';

export interface UserAgentSummary {
  readonly browser: string | null;
  readonly os: string | null;
  readonly deviceType: DeviceType;
  readonly raw: string | null;
}

const TOOLS =
  /\b(curl|wget|python-requests|python-urllib|aiohttp|axios|node-fetch|go-http-client|okhttp|java|libwww-perl|postmanruntime|insomnia|httpie)\b/i;
const BOTS =
  /\b(bot|crawler|spider|slurp|headlesschrome|phantomjs|puppeteer|playwright|selenium)\b/i;

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(e|A|iOS)?\/[\d.]+/, 'Edge'],
  [/\bOPR\/[\d.]+|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bHeadlessChrome\//, 'Headless Chrome'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\bWindows NT\b/, 'Windows'],
  [/\b(iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

export function summarizeUserAgent(raw: string | null | undefined): UserAgentSummary {
  const ua = (raw ?? '').trim();
  if (ua === '') return { browser: null, os: null, deviceType: 'unknown', raw: null };
  const tool = TOOLS.exec(ua)?.[1];
  const browser = tool ?? BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const os = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const deviceType: DeviceType =
    tool !== undefined || BOTS.test(ua)
      ? 'bot'
      : /\biPad\b|\bTablet\b/.test(ua) || (/\bAndroid\b/.test(ua) && !/\bMobile\b/.test(ua))
        ? 'tablet'
        : /\b(iPhone|iPod|Mobile)\b/.test(ua)
          ? 'phone'
          : os !== null
            ? 'desktop'
            : 'unknown';
  return { browser, os, deviceType, raw: ua };
}

/** A headless browser or an automation driver named in the agent. */
export function isHeadlessAgent(raw: string | null | undefined): boolean {
  return /\b(HeadlessChrome|PhantomJS|puppeteer|playwright|selenium)\b/i.test(raw ?? '');
}

/** A scripting tool or a self-declared bot — `curl`, `python-requests`, `axios`, `…bot`. */
export function isToolAgent(raw: string | null | undefined): boolean {
  const ua = raw ?? '';
  return TOOLS.test(ua) || /\b\w*bot\b/i.test(ua);
}
