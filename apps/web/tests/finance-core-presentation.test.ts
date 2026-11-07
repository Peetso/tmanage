import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/lib/api/errors';
import {
  isCannotApproveOwn,
  isoWeekFrom,
  mayDecide,
  parseAmountToMinor,
} from '../src/lib/finance-presentation';

describe('finance screens part 1 (A10a)', () => {
  it('never offers Approve/Reject on the member’s own submitted record (B20)', () => {
    expect(mayDecide('m-1', 'm-1', true, 'submitted')).toBe(false);
    expect(mayDecide('m-2', 'm-1', true, 'submitted')).toBe(true);
    expect(mayDecide('m-2', 'm-1', false, 'submitted')).toBe(false);
    expect(mayDecide('m-2', 'm-1', true, 'approved')).toBe(false);
    expect(mayDecide('m-2', undefined, true, 'submitted')).toBe(false);
  });

  it('recognises the API’s cannot_approve_own refusal', () => {
    const own = new ApiRequestError(403, 'forbidden', 'x', 'c', [
      { field: 'expenseId', message: 'cannot_approve_own' },
    ]);
    expect(isCannotApproveOwn(own)).toBe(true);
    expect(isCannotApproveOwn(new ApiRequestError(403, 'forbidden', 'x', 'c'))).toBe(false);
  });

  it('parses amounts into minor units by currency', () => {
    expect(parseAmountToMinor('1,250.5', 'SAR')).toBe(125050);
    expect(parseAmountToMinor('10.125', 'KWD')).toBe(10125);
    expect(parseAmountToMinor('1.5', 'JPY')).toBeNull();
    expect(parseAmountToMinor('0', 'SAR')).toBeNull();
    expect(isoWeekFrom('2026-11-02', 1)).toBe('2026-W46');
  });
});
