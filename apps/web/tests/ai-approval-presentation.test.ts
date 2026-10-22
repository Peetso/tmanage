import { describe, expect, it } from 'vitest';
import {
  clientInitial,
  fieldLabel,
  fillTemplate,
  formatCountdown,
} from '../src/lib/ai-approval-presentation';
import { safeReturnPath } from '../src/lib/sign-in-return';

describe('AI approve page presentation (S10)', () => {
  it('formats the expiry countdown as m:ss and never goes negative', () => {
    expect(formatCountdown(581_000)).toBe('9:41');
    expect(formatCountdown(600_000)).toBe('10:00');
    expect(formatCountdown(-5)).toBe('0:00');
  });

  it('turns argument keys into readable labels', () => {
    expect(fieldLabel('workItemId')).toBe('Work item');
    expect(fieldLabel('due_date')).toBe('Due date');
    expect(fieldLabel('id')).toBe('Id');
  });

  it('fills catalog placeholders and the client initial', () => {
    expect(fillTemplate('{client} asked for {name}', { client: 'Claude', name: 'Maya' })).toBe(
      'Claude asked for Maya',
    );
    expect(fillTemplate('{missing}', {})).toBe('{missing}');
    expect(clientInitial(' claude')).toBe('C');
  });

  it('lets sign-in return to an approve link, and to nothing that only looks like one', () => {
    const link = '/studio/ai/approve/01890000-0000-7000-8000-000000000001';
    expect(safeReturnPath(link)).toBe(link);
    expect(safeReturnPath('//evil.test/ai/approve/01890000-0000-7000-8000-000000000001')).toBe(
      '/organizations',
    );
    expect(safeReturnPath(`${link}?next=https://evil.test`)).toBe('/organizations');
  });
});
