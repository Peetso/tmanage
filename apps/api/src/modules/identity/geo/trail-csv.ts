import { StreamableFile } from '@nestjs/common';
import { escapeCsvCell } from '../../audit/audit-export-csv.js';
import type { IntelCoreView } from './session-intel.js';

/**
 * R12 (R1). The sign-in trail as a spreadsheet: one row per event (and the session itself first,
 * on the session exports), every time ISO-8601 UTC with `Z`. Cells go through the audit export's
 * formula-injection guard. There is deliberately no `reason` column — an event's reason is the
 * never-returned cause of a refusal, and an export must not become the way to read it.
 */
export const TRAIL_CSV_HEADER = [
  'occurredAtUtc',
  'action',
  'outcome',
  'ip',
  'country',
  'region',
  'city',
  'postalCode',
  'asn',
  'networkOwner',
  'networkKind',
  'tor',
  'vpnOrProxy',
  'browser',
  'os',
  'deviceType',
  'automationVerdict',
  'automationScore',
  'reasons',
  'userAgent',
] as const;

export interface TrailCsvRow {
  readonly occurredAt: Date;
  readonly action: string;
  readonly outcome: string;
  readonly ip: string | null;
  readonly intel: IntelCoreView;
}

export const TRAIL_CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
const BOM = '﻿';

export function trailToCsv(rows: readonly TrailCsvRow[]): string {
  const lines = [TRAIL_CSV_HEADER.join(',')];
  for (const row of rows) {
    const { location, network, device, automation } = row.intel;
    const cells = [
      row.occurredAt.toISOString(),
      row.action,
      row.outcome,
      row.ip,
      location?.country ?? location?.countryCode,
      location?.region,
      location?.city,
      location?.postalCode,
      network?.asn,
      network?.owner,
      network?.kind,
      network ? String(network.tor) : null,
      network?.vpnOrProxy,
      device.browser,
      device.os,
      device.deviceType,
      automation?.verdict,
      automation?.score,
      automation?.reasons.join(';'),
      device.raw,
    ];
    lines.push(cells.map((cell) => escapeCsvCell(cell == null ? '' : String(cell))).join(','));
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** The one method a download needs of the framework reply. */
export interface HeaderWriter {
  header(name: string, value: string): unknown;
}

/** Hand `csv` out with the safe-download headers of `audit-export.controller.ts`. */
export function csvDownload(reply: HeaderWriter, csv: string, filename: string): StreamableFile {
  const body = Buffer.from(csv, 'utf-8');
  reply.header('content-type', TRAIL_CSV_CONTENT_TYPE);
  reply.header('content-length', String(body.byteLength));
  reply.header('content-disposition', `attachment; filename="${filename}"`);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('cache-control', 'private, no-store');
  return new StreamableFile(body, { type: TRAIL_CSV_CONTENT_TYPE, length: body.byteLength });
}
