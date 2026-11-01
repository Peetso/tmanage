import { expect, it } from 'vitest';
import { intelOf } from './session-intel.js';
import { TRAIL_CSV_HEADER, trailToCsv } from './trail-csv.js';

it('R12 trail CSV: BOM, header order, UTC Z, formula guard, and no reason column', () => {
  const intel = intelOf(null, '=HYPERLINK("x")', null);
  const csv = trailToCsv([
    {
      occurredAt: new Date(Date.UTC(2026, 10, 1, 9)),
      action: 'sign_in',
      outcome: 'failed',
      ip: '-1',
      intel,
    },
  ]);
  const [header, line] = csv.slice(1).split('\r\n');
  expect([csv.charCodeAt(0), header]).toEqual([0xfeff, TRAIL_CSV_HEADER.join(',')]);
  expect(header?.split(',')).not.toContain('reason');
  expect(line?.startsWith("2026-11-01T09:00:00.000Z,sign_in,failed,'-1,")).toBe(true);
  expect(line?.endsWith(`"'=HYPERLINK(""x"")"`)).toBe(true);
});
