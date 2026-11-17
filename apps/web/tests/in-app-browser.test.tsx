import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InAppBrowserNotice } from '../src/components/screens/InAppBrowserNotice';
import { androidIntentUrl, detectInAppBrowser } from '../src/lib/in-app-browser';

/**
 * LANDFIX: visitors from a Meta ad land inside the Facebook / Instagram webview, where Google
 * refuses the sign-in. The helper names those browsers; the notice replaces the provider button.
 */

const UA = {
  facebookIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.37.104;FBBV/612345678;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]',
  facebookAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/479.0.0.48.82;]',
  instagram:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 345.0.0.32.97 (iPhone15,2; iOS 17_5; en_US; en; scale=3.00; 1179x2556; 634108168)',
  line: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.10.0',
  tiktok:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_35.1.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 13; SM-S911B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.0.0 Mobile Safari/537.36',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  safariIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeLinux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
};

describe('detectInAppBrowser', () => {
  it.each([
    ['Facebook iOS', UA.facebookIos, false],
    ['Facebook Android', UA.facebookAndroid, true],
    ['Instagram', UA.instagram, false],
    ['LINE', UA.line, false],
    ['TikTok', UA.tiktok, false],
    ['Android WebView', UA.androidWebView, true],
  ])('names %s an in-app browser', (_name, ua, android) => {
    expect(detectInAppBrowser(ua)).toEqual({ inApp: true, android });
  });

  it.each([
    ['Chrome on Android', UA.chromeAndroid, true],
    ['Safari on iOS', UA.safariIos, false],
    ['Chrome on Linux', UA.chromeLinux, false],
  ])('leaves %s alone', (_name, ua, android) => {
    expect(detectInAppBrowser(ua)).toEqual({ inApp: false, android });
  });

  it('treats a missing agent as an ordinary browser', () => {
    expect(detectInAppBrowser(undefined)).toEqual({ inApp: false, android: false });
  });
});

describe('androidIntentUrl', () => {
  it('hands the page to Chrome and falls back to the same page', () => {
    expect(androidIntentUrl('https://tmanage.peetrix.com/sign-up?x=1#top')).toBe(
      'intent://tmanage.peetrix.com/sign-up?x=1#Intent;scheme=https;package=com.android.chrome;' +
        'S.browser_fallback_url=https%3A%2F%2Ftmanage.peetrix.com%2Fsign-up%3Fx%3D1;end',
    );
  });

  it('refuses anything but http(s)', () => {
    expect(androidIntentUrl('javascript:alert(1)')).toBeUndefined();
    expect(androidIntentUrl('not a url')).toBeUndefined();
  });
});

describe('InAppBrowserNotice', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names Google, copies the link and offers no Open link off Android', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(window.navigator.clipboard, 'writeText').mockResolvedValue();
    render(<InAppBrowserNotice google microsoft={false} android={false} />);
    expect(
      screen.getByText('To continue with Google, open this page in your browser.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open in browser' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(screen.getByRole('status')).toHaveTextContent('Link copied');
  });

  it('shows the address when the clipboard is refused, and the intent link on Android', async () => {
    const user = userEvent.setup();
    vi.spyOn(window.navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    render(<InAppBrowserNotice google microsoft android />);
    expect(
      screen.getByText('To continue with Google or Microsoft, open this page in your browser.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in browser' }).getAttribute('href')).toMatch(
      /^intent:\/\//,
    );
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(screen.getByText(window.location.href)).toBeInTheDocument();
  });
});
