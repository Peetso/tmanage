import { render, screen } from '@testing-library/react';
import { NextRequest, NextResponse } from 'next/server';
import { describe, expect, it } from 'vitest';
import { NotFoundState } from '../src/components/state/StateScreens';
import { rememberSignupAttribution } from '../src/lib/signup-attribution-cookie';

/** ADTRACK part 1 (2026-11-16): where a sign-up came from, kept first-party. */
describe('ad landing attribution', () => {
  it('keeps only valid utm values in an httpOnly, Secure, SameSite=Lax cookie for 30 days', () => {
    const response = NextResponse.next();
    rememberSignupAttribution(
      new NextRequest(
        'https://tmanageapp.com/?utm_source=facebook&utm_medium=%3Cscript%3E&utm_campaign=tm_beta_traffic',
      ),
      response,
    );
    expect(response.cookies.get('tm_signup_source')).toMatchObject({
      value: 'utm_source=facebook&utm_campaign=tm_beta_traffic',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 2_592_000,
    });
  });

  it('writes no cookie for a visit without utm values', () => {
    const response = NextResponse.next();
    rememberSignupAttribution(new NextRequest('https://tmanageapp.com/pricing'), response);
    expect(response.cookies.get('tm_signup_source')).toBeUndefined();
  });
});

describe('the public 404 page', () => {
  it('offers sign-in beside the way home', () => {
    render(<NotFoundState signInHref="/sign-in" autoFocusAction={false} />);
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in');
  });
});
