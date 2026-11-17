/**
 * In-app browsers (LANDFIX): a visitor from a Meta ad opens the site inside the Facebook or
 * Instagram webview, where Google refuses its sign-in (`disallowed_useragent`). The sign-in and
 * sign-up screens use this to show the e-mail form first and a "open this page in your browser"
 * line in place of the provider buttons.
 *
 * Detection is only a convenience: a wrong answer shows or hides a button, nothing else. No
 * security decision depends on it.
 */

/** User-agent tokens of the in-app browsers that break provider sign-in. */
const IN_APP_TOKENS: readonly RegExp[] = [
  /\bFBAN\//, // Facebook (iOS)
  /\bFBAV\//, // Facebook (both)
  /\bFB_IAB\//, // Facebook in-app browser (Android)
  /\bInstagram\b/,
  /\bLine\//, // LINE; case-sensitive, so "Linux" never matches
  /\bmusical_ly/, // TikTok (older builds)
  /\bTikTok\b/,
  /\bBytedanceWebview\//, // TikTok (Android)
];

/** Android's System WebView marks itself with `; wv)` in the platform part of the agent. */
const ANDROID_WEBVIEW = /; wv\)/;

export interface InAppBrowser {
  /** True inside a known in-app browser or an Android WebView. */
  readonly inApp: boolean;
  /** True on Android, where an `intent:` link can hand the page to Chrome. */
  readonly android: boolean;
}

export function detectInAppBrowser(userAgent: string | undefined | null): InAppBrowser {
  const ua = userAgent ?? '';
  const android = /\bAndroid\b/.test(ua);
  const inApp =
    IN_APP_TOKENS.some((token) => token.test(ua)) || (android && ANDROID_WEBVIEW.test(ua));
  return { inApp, android };
}

/**
 * The standard Android `intent:` link that opens `href` in Chrome, falling back to the same page
 * when Chrome is not installed (so the link is never dead). Only http(s) pages; the fragment is
 * dropped because `#Intent` takes its place.
 */
export function androidIntentUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  url.hash = '';
  const scheme = url.protocol.slice(0, -1);
  const rest = `${url.host}${url.pathname}${url.search}`;
  return (
    `intent://${rest}#Intent;scheme=${scheme};package=com.android.chrome;` +
    `S.browser_fallback_url=${encodeURIComponent(url.toString())};end`
  );
}
