/**
 * R12 / R1 — what the API knows about where a session or a sign-in came from (SPEC §5).
 *
 * Hand-written, like `display-preferences.ts`: slice 2 produces `SessionIntelView` on the session
 * lists and the person security reads, and the three trail CSV routes. Every alias here is an
 * object-literal `type`, so the contracts gate does not enumerate it as a second response shape —
 * it is covered through the paired row that carries it (`ActiveSessionView`, `SessionSummary`,
 * `PlatformPersonSessionView`, `PlatformPersonAccessView`).
 *
 * Location is never exact: `approximate` is always `true`, and `attribution` names the free
 * database (DB-IP Lite, CC BY 4.0) whenever one answered.
 */

export type AutomationVerdict = 'likely_person' | 'unclear' | 'likely_automated';

export type IntelLocation = {
  readonly countryCode: string | null;
  readonly country: string | null;
  readonly region: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly approximate: true;
  readonly attribution: 'DB-IP' | null;
};

export type IntelNetwork = {
  readonly asn: number | null;
  readonly owner: string | null;
  readonly kind: 'residential' | 'hosting' | 'local' | 'unknown';
  readonly tor: boolean;
  readonly vpnOrProxy: 'likely' | 'unknown';
};

export type IntelDevice = {
  readonly browser: string | null;
  readonly os: string | null;
  readonly deviceType: 'desktop' | 'phone' | 'tablet' | 'bot' | 'unknown';
  readonly raw: string | null;
};

export type IntelAutomation = {
  readonly verdict: AutomationVerdict;
  readonly score: number;
  /** Reason codes (`ua_headless`, `hosting_ip`, …) — always shown with the verdict. */
  readonly reasons: readonly string[];
};

/** One session: both IPs, where the last one points, the device and the sign-in signal. */
export type SessionIntelView = {
  readonly ipFirst: string | null;
  readonly ipLast: string | null;
  readonly location: IntelLocation | null;
  readonly network: IntelNetwork | null;
  readonly device: IntelDevice;
  readonly automation: IntelAutomation | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
};

/** One sign-in event: the same facts without first/last, plus when and what happened. */
export type SignInIntelView = {
  readonly location: IntelLocation | null;
  readonly network: IntelNetwork | null;
  readonly device: IntelDevice;
  readonly automation: IntelAutomation | null;
  readonly ip: string | null;
  readonly occurredAt: string;
  readonly action: string;
  readonly outcome: string;
};

/** The facts every card and cell reads — common to a session and a sign-in event. */
export type IntelFacts = {
  readonly ipFirst?: string | null;
  readonly ipLast?: string | null;
  readonly location: IntelLocation | null;
  readonly network: IntelNetwork | null;
  readonly device: IntelDevice;
  readonly automation: IntelAutomation | null;
};

/** The points each reason adds — mirrors the API's `AUTOMATION_WEIGHTS`, for display only. */
export const AUTOMATION_REASON_POINTS: Readonly<Record<string, number>> = {
  ua_headless: 40,
  ua_tool: 40,
  ch_headless: 30,
  webdriver: 35,
  form_too_fast: 20,
  no_keystrokes: 15,
  hosting_ip: 15,
  tor_ip: 10,
  rate_high: 15,
  accept_language_missing: 10,
};

/** One parsed row of a trail CSV (slice 2's column order; every time ISO-8601 UTC). */
export type TrailRow = Readonly<Record<string, string>>;

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** Parse an RFC 4180 CSV (BOM, quoted cells, doubled quotes) into rows keyed by the header. */
export function parseTrailCsv(text: string): TrailRow[] {
  const source = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  const records: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      records.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) records.push([...row, cell]);
  const [header, ...body] = records.filter((r) => r.some((c) => c !== ''));
  if (!header) return [];
  return body.map((r) =>
    Object.fromEntries(header.map((name, index) => [name, unescapeCell(r[index] ?? '')])),
  );
}

/** Undo the export's formula guard: a leading `'` before `= + - @` was added by the server. */
function unescapeCell(value: string): string {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

/** Read a trail CSV with the session cookie (a `GET`, no CSRF token). */
export async function fetchTrailCsv(
  url: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const response = await fetchImpl(url, { method: 'GET', credentials: 'include' });
  if (!response.ok) throw new Error(`trail_csv_${response.status}`);
  return response.text();
}

/** Fetch a trail CSV with the session cookie and hand it to the browser as a save. */
export async function downloadTrailCsv(
  url: string,
  fileName: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  let blob: Blob;
  try {
    const response = await fetchImpl(url, { method: 'GET', credentials: 'include' });
    if (!response.ok) return false;
    // The bytes as sent: the server's UTF-8 BOM keeps Arabic readable in Excel.
    blob = await response.blob();
  } catch {
    return false;
  }
  if (typeof URL.createObjectURL !== 'function') return true;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
  return true;
}
