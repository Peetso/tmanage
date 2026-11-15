import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { useRoleDescription, useStatusLabel } from '../src/lib/use-role-description';

/**
 * UX test of live 69836a13, T-P1-5: the profile and permissions screens showed the role names, what
 * each role can do, and the member status in English on an Arabic screen.
 */
afterEach(() => activeLocale.set('en-US'));

describe('role descriptions in the reader’s language', () => {
  it('keeps the English source in English', () => {
    const { result } = renderHook(() => useRoleDescription());
    const owner = result.current('owner');
    expect(owner.label).toBe('Owner');
    expect(owner.grants[0]).toBe('Everything an organization admin can do');
  });

  it('translates the label, every grant and the limit in Arabic', () => {
    activeLocale.set('ar-EG');
    const { result } = renderHook(() => useRoleDescription());
    const owner = result.current('owner');
    expect(owner.label).toBe('المالك');
    expect(owner.grants).toHaveLength(3);
    for (const line of [...owner.grants, owner.withholds]) expect(line).not.toMatch(/[A-Za-z]/);
    expect(result.current('manager').label).toBe('مدير');
    // An unknown role keeps its raw name; its explanation is still translated.
    const unknown = result.current('something_new');
    expect(unknown.label).toBe('something_new');
    expect(unknown.withholds).not.toMatch(/[A-Za-z]/);
  });

  it('translates the status, and leaves an unknown one as it is', () => {
    activeLocale.set('ar-EG');
    const { result } = renderHook(() => useStatusLabel());
    expect(result.current('active')).toBe('نشط');
    expect(result.current('mystery')).toBe('mystery');
  });
});
