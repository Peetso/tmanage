/**
 * AI action registry — the enrichment contract (schemas, redaction, presentation).
 *
 * Added by slice S4 of the TManage AI connector (MCP). See
 * `MCP-CONNECTOR-PLAN-2026-10-20.md` §3, §7 (S2–S4) and
 * `MCP-CONNECTOR-ARCHITECTURE-2026-10-20.md` B3 / B4 (T-REG, T-INJ, T-RED).
 *
 * S1 fixed the *classification* of every route (id, method, path, capability, risk, scope) in
 * `index.ts`. The registry wave slices (S2 wave A, S3 wave B, S4 wave C) attach the rest of what
 * an op needs to be callable and safe: a hand-authored zod `input` schema (`.strict()` so unknown
 * keys are rejected before the in-process inject — architecture B3/T-INJ), a per-op `redact`
 * profile (architecture B4/T-RED), a `notifies` flag (surfaced to clients as `openWorldHint`), a
 * plain-English `title`/`description`, and worked `examples`. The concrete MCP tool shape (the
 * `ZodRawShape` the SDK's `registerTool` wants) and the compact/full catalogs are assembled from
 * these details in slice S5 (`mcp/tool-catalog.ts`); keeping the detail here, next to the op's
 * classification, is what lets the contract tests (T-REG-03) drive MCP and REST from one source.
 *
 * The detail layer is deliberately *additive* and keyed by op id, so the three registry waves do
 * not contend on `index.ts`: each wave ships its own per-area detail files plus a wave barrel.
 */
import { z } from 'zod';

/**
 * Per-op redaction profile (architecture B4/T-RED). The profile names which field family the op's
 * result belongs to; `redact.ts` (slice S6) maps each profile × the caller's role to the concrete
 * allowlist, reusing the 12-PERMISSION-MATRIX logic. No profile ever returns token hashes, client
 * secrets, IP addresses or security metadata to any AI principal, and the client-facing profiles
 * additionally strip internal notes and member-private data.
 */
export const REDACT_PROFILES = [
  /** Default internal read: member-visible fields; strips security/audit internals. */
  'standard',
  /** Safe for client-portal roles: no internal notes, no member-private data, no internal ids. */
  'client_safe',
  /** Personal data (people module): private contact details and notes only for self or a manager. */
  'people',
  /** Billing figures and documents: strips payment-provider references and any stored secrets. */
  'billing',
  /** Audit events: strips token hashes, raw request bodies, and IP addresses. */
  'audit',
  /** User- or org-authored config blobs (preferences, saved views, layouts): no secrets. */
  'config',
] as const;
export type RedactProfile = (typeof REDACT_PROFILES)[number];

/** A worked example for the tool description — a human summary and a valid `input` payload. */
export interface AiActionExample {
  readonly summary: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * The enrichment attached to one classified op (its id matches an `AiActionOp.id` in `index.ts`).
 * `input` is validated before the op runs; `output` is optional (documentation/shape only).
 */
export interface AiActionDetail {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly input: z.ZodTypeAny;
  readonly output?: z.ZodTypeAny;
  readonly redact: RedactProfile;
  /** True when running the op sends or shows something to other people (openWorldHint). */
  readonly notifies: boolean;
  readonly examples: readonly AiActionExample[];
}

/**
 * Field builders. `orgSlug` is never an argument — the tenant is taken from the grant and an
 * `orgSlug` passed by the model is ignored (architecture B3/T-TEN-01) — so path params below are
 * only the *other* `:params`.
 */
export const f = {
  /** An opaque resource id or key path-segment. */
  id: (max = 64) => z.string().min(1).max(max),
  /** A short free-text field (titles, labels, names). */
  shortText: (max = 300) => z.string().min(1).max(max),
  /** A long free-text field (comments, bodies). */
  text: (max = 5000) => z.string().min(1).max(max),
  bool: () => z.boolean(),
  int: (min = 0, max = 1_000_000) => z.number().int().min(min).max(max),
  /** ISO-8601 date or instant, as a string (the API coerces/validates further). */
  iso: () => z.string().min(1).max(40),
  /** A bounded JSON config blob for endpoints that persist arbitrary structured settings. */
  config: () => z.record(z.string().max(120), z.unknown()),
  /** Common collection-paging controls. */
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().max(512).optional(),
} as const;

function strict(shape: z.ZodRawShape): z.ZodObject<z.ZodRawShape> {
  return z.object(shape).strict();
}

function pathShape(params: readonly string[]): z.ZodRawShape {
  return Object.fromEntries(params.map((p) => [p, f.id()]));
}

/** No arguments beyond the tenant (whole-org read/action). */
export function noArgs(): z.ZodTypeAny {
  return strict({});
}

/** A read/action whose only arguments are path params. */
export function pathOnly(...params: string[]): z.ZodTypeAny {
  return strict(pathShape(params));
}

/** A collection list: path params plus optional `limit`/`cursor` (and any extra query fields). */
export function listArgs(params: string[] = [], extra: z.ZodRawShape = {}): z.ZodTypeAny {
  return strict({ ...pathShape(params), limit: f.limit, cursor: f.cursor, ...extra });
}

/** A write/confirm op: path params plus a body shape. */
export function bodyArgs(params: string[], body: z.ZodRawShape): z.ZodTypeAny {
  return strict({ ...pathShape(params), ...body });
}

/** Build a detail, defaulting `notifies` to false and `examples` to empty. */
export function det(d: {
  id: string;
  title: string;
  description: string;
  input: z.ZodTypeAny;
  output?: z.ZodTypeAny;
  redact: RedactProfile;
  notifies?: boolean;
  examples?: readonly AiActionExample[];
}): AiActionDetail {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    input: d.input,
    ...(d.output !== undefined ? { output: d.output } : {}),
    redact: d.redact,
    notifies: d.notifies ?? false,
    examples: d.examples ?? [],
  };
}

/** Index a list of details by id, throwing on a duplicate (a wave authoring mistake). */
export function indexById(details: readonly AiActionDetail[]): ReadonlyMap<string, AiActionDetail> {
  const map = new Map<string, AiActionDetail>();
  for (const d of details) {
    if (map.has(d.id)) throw new Error(`duplicate AI action detail id: ${d.id}`);
    map.set(d.id, d);
  }
  return map;
}
