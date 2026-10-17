import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import { validateOrganizationInput } from './organization-input.js';

describe('validateOrganizationInput', () => {
  it('returns trimmed values for a valid body', () => {
    expect(
      validateOrganizationInput({
        name: '  Acme Studio ',
        slug: ' acme-studio ',
        timezone: ' Africa/Cairo ',
        defaultLocale: ' ar ',
      }),
    ).toEqual({
      name: 'Acme Studio',
      slug: 'acme-studio',
      timezone: 'Africa/Cairo',
      defaultLocale: 'ar',
    });
  });

  it('refuses the reserved slug setup', () => {
    let caught: unknown;
    try {
      validateOrganizationInput({ name: 'Acme', slug: 'setup' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe('validation_failed');
    expect(apiError.details?.some((detail) => detail.field === 'slug')).toBe(true);
  });
});
