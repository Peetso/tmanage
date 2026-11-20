import { describe, expect, it, vi } from 'vitest';
import { deriveUnsubscribeKey, signUnsubscribeToken } from '@tmanage/mail';
import { UnsubscribeController } from './unsubscribe.controller.js';

/**
 * PERSONMAIL (ADR-0013) — the footer's links. Opened in a browser (GET) the unsubscribe link never
 * acts: a valid token goes to the web page that asks for one click and says what still comes; the
 * "Notification settings" link (no token) and anything forged go to the app.
 */

const KEY = deriveUnsubscribeKey('suite-secret');
const WEB = 'https://tmanageapp.com';

function reply() {
  const headers = new Map<string, string>();
  let status = 0;
  return {
    headers,
    get status() {
      return status;
    },
    api: {
      status: (code: number) => {
        status = code;
      },
      header: (name: string, value: string) => {
        headers.set(name, value);
      },
    },
  };
}

describe('PERSONMAIL — unsubscribe link opened in a browser', () => {
  const suppress = vi.fn(async () => undefined);
  const controller = new UnsubscribeController({ key: KEY, webPublicUrl: WEB }, {
    suppress,
  } as never);

  it('a valid token is sent to the one-click page and nothing is suppressed', () => {
    const token = signUnsubscribeToken(KEY, 'reader@example.com');
    const r = reply();
    controller.opened(token, r.api);
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`${WEB}/unsubscribe/${token}`);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(suppress).not.toHaveBeenCalled();
  });

  it('no token (the settings link) or a forged one goes to the app', () => {
    for (const token of [undefined, 'v1.forged.token', ['a', 'b']]) {
      const r = reply();
      controller.opened(token, r.api);
      expect(r.headers.get('location')).toBe(`${WEB}/`);
    }
  });
});
