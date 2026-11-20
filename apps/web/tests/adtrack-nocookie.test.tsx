import { render, screen } from '@testing-library/react';
import { NextRequest, NextResponse } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { embedSrc } from '../src/components/docs/editor/schema-extensions';
import { SignupLinkCarrier } from '../src/components/website/SignupLinkCarrier';
import { FOOTER_LEGAL } from '../src/components/website/site-nav';
import { NotFoundState } from '../src/components/state/StateScreens';
import { translate } from '../src/lib/i18n/t';
import {
  carriedSignupParams,
  forgetLegacySignupAttribution,
  signupAttributionFromSearch,
  withCarriedSignupParams,
} from '../src/lib/signup-attribution';

const push = vi.fn();

/**
 * ADTRACK without a cookie (NOCOOKIE, 2026-11-20). The campaign tags and the invite code ride in
 * the address from the landing page to the sign-up form; no cookie or browser storage is written,
 * and the retired `tm_signup_source` cookie is expired once.
 */
describe('sign-up attribution in the address', () => {
  afterEach(() => {
    push.mockReset();
    window.history.replaceState(null, '', '/');
    document.body.innerHTML = '';
  });

  it('carries only valid utm values and a well-formed ref code', () => {
    expect(
      carriedSignupParams(
        '?utm_source=facebook&utm_medium=%3Cscript%3E&utm_campaign=tm_beta_traffic&utm_term=x&ref=nile-ab3cd4&lang=ar',
      ),
    ).toEqual([
      ['utm_source', 'facebook'],
      ['utm_campaign', 'tm_beta_traffic'],
      ['ref', 'nile-ab3cd4'],
    ]);
    expect(carriedSignupParams('?ref=<bad>')).toEqual([]);
    expect(signupAttributionFromSearch('?utm_source=facebook&ref=nile-ab3cd4')).toEqual({
      utm_source: 'facebook',
    });
  });

  it('adds them only to same-origin sign-up links, keeping what a link already has', () => {
    const carried = [
      ['utm_source', 'facebook'],
      ['ref', 'nile-ab3cd4'],
    ] as const;
    const origin = 'https://tmanageapp.com';
    expect(withCarriedSignupParams('/sign-up', carried, origin)).toBe(
      '/sign-up?utm_source=facebook&ref=nile-ab3cd4',
    );
    expect(withCarriedSignupParams('/ar/sign-up?plan=team#top', carried, origin)).toBe(
      '/ar/sign-up?plan=team&utm_source=facebook&ref=nile-ab3cd4#top',
    );
    expect(withCarriedSignupParams('/sign-up?utm_source=google', carried, origin)).toBe(
      '/sign-up?utm_source=google&ref=nile-ab3cd4',
    );
    for (const href of ['/pricing', '/sign-in', 'https://evil.example/sign-up', '']) {
      expect(withCarriedSignupParams(href, carried, origin), href).toBeUndefined();
    }
    expect(withCarriedSignupParams('/sign-up', [], origin)).toBeUndefined();
  });

  it('a click on any sign-up link of the website goes to it with the landing values, no storage', () => {
    window.history.replaceState(null, '', '/?utm_source=facebook&utm_campaign=tm_beta_traffic');
    const cookieWrites = vi.spyOn(document, 'cookie', 'set');
    const localWrites = vi.spyOn(Storage.prototype, 'setItem');
    render(
      <>
        <SignupLinkCarrier navigate={push} />
        <a href="/sign-up">Start free</a>
        <a href="/pricing">Pricing</a>
      </>,
    );
    // Moving to another website page (client navigation) keeps the landing values in memory.
    window.history.replaceState(null, '', '/features');
    screen.getByRole('link', { name: 'Start free' }).click();
    expect(push).toHaveBeenCalledWith('/sign-up?utm_source=facebook&utm_campaign=tm_beta_traffic');
    expect(screen.getByRole('link', { name: 'Start free' }).getAttribute('href')).toBe(
      '/sign-up?utm_source=facebook&utm_campaign=tm_beta_traffic',
    );
    screen.getByRole('link', { name: 'Pricing' }).click();
    expect(push).toHaveBeenCalledTimes(1);
    expect(cookieWrites).not.toHaveBeenCalled();
    expect(localWrites).not.toHaveBeenCalled();
    cookieWrites.mockRestore();
    localWrites.mockRestore();
  });

  it('the proxy writes no attribution cookie and expires the retired one once', () => {
    const fresh = NextResponse.next();
    forgetLegacySignupAttribution(
      new NextRequest('https://tmanageapp.com/?utm_source=facebook', {
        headers: { referer: 'https://chatgpt.com/' },
      }),
      fresh,
    );
    expect(fresh.cookies.getAll()).toEqual([]);

    const old = NextResponse.next();
    forgetLegacySignupAttribution(
      new NextRequest('https://tmanageapp.com/pricing', {
        headers: { cookie: 'tm_signup_source=utm_source%3Dfacebook' },
      }),
      old,
    );
    expect(old.cookies.get('tm_signup_source')).toMatchObject({ value: '', maxAge: 0, path: '/' });
  });
});

describe('cookie footprint of the site', () => {
  it('the footer "Cookies" link opens the privacy page at its cookie section', () => {
    const link = FOOTER_LEGAL.find((item) => item.href.includes('#cookies'));
    expect(link?.href).toBe('/legal/privacy#cookies');
    expect(translate('en', link!.label)).toBe('Cookies');
    expect(translate('ar', link!.label)).toBe('ملفات تعريف الارتباط');
  });

  it('YouTube embeds use the no-cookie host', () => {
    expect(embedSrc('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
    expect(embedSrc('https://youtu.be/dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
  });
});

describe('the public 404 page', () => {
  it('offers sign-in beside the way home', () => {
    render(<NotFoundState signInHref="/sign-in" autoFocusAction={false} />);
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in');
  });
});
