import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AiActionOp } from '../ai-actions/registry/index.js';
import { findOpById, findOpByRoute, isPlatformOp, routeKey } from '../ai-actions/registry/index.js';
import { PLATFORM_TWO_PERSON_ROUTES } from '../ai-actions/registry/platform-op.js';
import type { AiActionDetail } from '../ai-actions/registry/detail.js';
import { allDetailsById } from './tool-catalog.js';
import { argsSha256 } from './internal-grant.js';
import { mcpBodyShapeRefusal } from './mcp-body-shape.js';
import { amountOf, changeGateFor } from '../copilot/ai-preview.js';

/**
 * **Confirm-class approvals — the pure half (MCP connector S10, plan §4.3, architecture F3).**
 *
 * A confirm-class op (every DELETE; anything that sends, invites, publishes, bills, …) is never
 * run by the AI call that asks for it. The call freezes the op id and its schema-validated
 * arguments into a `pending_ai_actions` row and answers with an approval link. The op runs only
 * when the same member, signed in on the TManage website, presses Approve — on the server, once,
 * with exactly the frozen arguments (`T-APR-01..04`).
 *
 * Everything here is side-effect free so the rules can be unit tested without a database:
 * freezing and validating, turning an op + args into the in-process request, the human summary
 * the approve page shows, the MRTR / link-fallback answer to the AI client, and the signed
 * `requestState` a retried call carries.
 */

/** A pending approval lives ten minutes (plan §4.3). */
export const PENDING_AI_ACTION_TTL_MS = 10 * 60 * 1000;

/** The cap on a stored op result (architecture B4: pages ≤ 64 KB). */
export const MAX_RESULT_BYTES = 64 * 1024;

export const PENDING_STATUSES = ['pending', 'approved', 'declined', 'expired', 'failed'] as const;
export type PendingStatus = (typeof PENDING_STATUSES)[number];

export class PendingActionRefusedError extends Error {
  constructor(
    readonly code: 'unknown_action' | 'not_confirm_class' | 'invalid_args',
    message: string,
  ) {
    super(message);
    this.name = 'PendingActionRefusedError';
  }
}

/** A confirm-class op with its arguments validated and frozen. */
export interface FrozenAction {
  readonly op: AiActionOp;
  readonly detail: AiActionDetail;
  readonly args: Record<string, unknown>;
  readonly argsSha256: string;
}

/**
 * Validate a requested confirm-class action and freeze it. The op must exist, carry a detail, and
 * be classified `confirm`; the arguments must pass the op's strict schema (unknown keys refused),
 * and the parsed — not the raw — arguments are what gets stored and later run.
 */
export function freezeConfirmAction(opId: string, rawArgs: unknown): FrozenAction {
  const op = findOpById(opId);
  const detail = allDetailsById.get(opId);
  if (op === undefined || detail === undefined) {
    throw new PendingActionRefusedError('unknown_action', `Unknown action: ${opId}`);
  }
  if (op.risk !== 'confirm') {
    throw new PendingActionRefusedError('not_confirm_class', `${opId} does not need approval`);
  }
  // GHSA-mrhx-c7xc-m3w5: no oversized collection reaches the op's zod schema, whichever channel
  // (MCP or a personal access token on the REST route) asked for the approval.
  if (mcpBodyShapeRefusal(rawArgs) !== undefined) {
    throw new PendingActionRefusedError('invalid_args', `Invalid arguments for ${opId}`);
  }
  const parsed = detail.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    throw new PendingActionRefusedError('invalid_args', `Invalid arguments for ${opId}`);
  }
  const args = parsed.data as Record<string, unknown>;
  // AI tamper review 2026-11-23: a row is frozen only when its request can be built, so the approve
  // page never shows an action whose path argument would send it to another route (`..`).
  buildOpRequest(op, args, 'frozen');
  return { op, detail, args, argsSha256: argsSha256({ opId, args }) };
}

/**
 * Re-check a stored action before it runs: the op must still be a confirm-class op with a detail,
 * and the stored arguments must still hash to the stored hash. A row edited at rest, or an op
 * reclassified since, is refused rather than run.
 */
export function verifyFrozenAction(
  opId: string,
  args: Record<string, unknown>,
  storedSha256: string,
): FrozenAction | undefined {
  try {
    const frozen = freezeConfirmAction(opId, args);
    return frozen.argsSha256 === storedSha256 ? frozen : undefined;
  } catch {
    return undefined;
  }
}

/** The in-process request one op becomes. */
export interface OpRequest {
  readonly method: string;
  readonly url: string;
  readonly body?: string;
}

/**
 * A path argument the URL parser would turn into a different path: `.` and `..` are dot segments
 * that `new URL()` (and so `fastify.inject`) resolves before routing, and an empty value collapses
 * the segment. `files/:fileId/...` with `..` would reach another route than the op (and the card
 * or approve page) names (AI tamper review 2026-11-23; OWASP LLM06, ASVS 5.0 V1.3).
 */
export function isUnsafePathSegment(value: string): boolean {
  return value === '' || value === '.' || value === '..';
}

/**
 * Turn an op and its frozen args into the request the in-process inject sends. `:orgSlug` comes
 * from the approver's route (the tenant is never an argument); every other `:param` comes from
 * the args, URL-encoded, and is never a dot segment ({@link isUnsafePathSegment}); the rest is a
 * query string for a GET and a JSON body otherwise.
 */
export function buildOpRequest(
  op: AiActionOp,
  args: Record<string, unknown>,
  orgSlug: string,
): OpRequest {
  const used = new Set<string>();
  // The registry keeps a controller's root route as reflected (`…/projects/`); Fastify routes it
  // without the trailing slash and 404s the slashed form, so the request drops it.
  const routePath = op.path.length > 1 ? op.path.replace(/\/+$/, '') : op.path;
  const path = routePath.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    if (name === 'orgSlug') return encodeURIComponent(orgSlug);
    const value = args[name];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new PendingActionRefusedError('invalid_args', `Missing path argument ${name}`);
    }
    if (isUnsafePathSegment(String(value))) {
      throw new PendingActionRefusedError('invalid_args', `Invalid path argument ${name}`);
    }
    used.add(name);
    return encodeURIComponent(String(value));
  });
  const rest = Object.entries(args).filter(([key]) => !used.has(key) && key !== 'orgSlug');
  if (op.method === 'GET') {
    const query = new URLSearchParams();
    for (const [key, value] of rest) {
      if (value !== undefined && value !== null) query.append(key, String(value));
    }
    const search = query.toString();
    return { method: op.method, url: search === '' ? path : `${path}?${search}` };
  }
  // A non-GET route may read some arguments from its query string (`AiActionOp.queryArgs`).
  const inQuery = new Set(op.queryArgs ?? []);
  const query = new URLSearchParams();
  for (const [key, value] of rest) {
    if (inQuery.has(key) && value !== undefined && value !== null) query.append(key, String(value));
  }
  const search = query.toString();
  const url = search === '' ? path : `${path}?${search}`;
  const body = rest.filter(([key]) => !inQuery.has(key));
  if (body.length === 0) return { method: op.method, url };
  return { method: op.method, url, body: JSON.stringify(Object.fromEntries(body)) };
}

/** A `pending` row past its expiry reads as `expired`, whatever the stored value says. */
export function effectiveStatus(
  row: { readonly status: string; readonly expiresAt: Date },
  now: Date,
): PendingStatus {
  const status = (PENDING_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as PendingStatus)
    : 'failed';
  if (status === 'pending' && row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return status;
}

/** One detail row the approve page shows: an argument name and its value, as plain text. */
export interface SummaryField {
  readonly name: string;
  readonly value: string;
}

/**
 * What the approve page shows. Generated by the server from the registry and the frozen args —
 * never by the model — so a tricked AI cannot word the request to hide what it does.
 */
export interface ApprovalSummary {
  readonly opId: string;
  /** The op's plain-English title, e.g. "Delete work item". */
  readonly title: string;
  readonly method: string;
  /** A DELETE: the page uses the destructive wording and button. */
  readonly destructive: boolean;
  /** The op reaches other people (sends, invites, publishes). */
  readonly notifies: boolean;
  /**
   * The name of the thing the action is about — the work item's title, the invitee's email — for
   * the page's bold line (Figma 365:1229, `Delete “Homepage direction review”`). `null` when
   * neither the arguments nor a read of the target name it.
   */
  readonly subject: string | null;
  readonly fields: readonly SummaryField[];
  /**
   * ADR-0015 F9: present only for a platform action. Built by the server from the frozen, hashed
   * arguments: the platform permission used, whether a second admin must approve while the
   * two-person policy is on, and the reason the person will be recorded as giving. The reason was
   * drafted by the AI and is approved by the person when they confirm (`reasonDraftedByAi`).
   */
  readonly platform?: PlatformSummary;
}

/** ADR-0015 F9: what a platform action's card and approve page show beyond the fields. */
export interface PlatformSummary {
  readonly permission: string | null;
  readonly secondAdminWhenPolicyOn: boolean;
  readonly reason: string | null;
  readonly reasonDraftedByAi: boolean;
}

/** F9: the platform block of a frozen platform action, or `undefined` for any other op. */
export function platformSummaryOf(
  op: AiActionOp,
  args: Record<string, unknown>,
): PlatformSummary | undefined {
  if (!isPlatformOp(op)) return undefined;
  const raw = args['reason'];
  const reason = typeof raw === 'string' && raw.trim() !== '' ? fieldText(raw.trim()) : null;
  return {
    permission: op.platformPermission ?? null,
    secondAdminWhenPolicyOn: PLATFORM_TWO_PERSON_ROUTES.has(routeKey(op.method, op.path)),
    reason,
    reasonDraftedByAi: reason !== null,
  };
}

/**
 * F9: the platform read that names a platform action's target — the company or the person — by
 * the server, from the frozen arguments (`organizationId` / `id` of a company, `userId`).
 */
export function platformTargetLookup(
  op: AiActionOp,
  args: Record<string, unknown>,
): { readonly op: AiActionOp; readonly args: Record<string, unknown> } | undefined {
  if (!isPlatformOp(op) || op.method === 'GET') return undefined;
  const person = args['userId'];
  if (typeof person === 'string' && op.path.includes(':userId')) {
    const read = findOpByRoute('GET', '/v1/platform/people/:userId');
    return read === undefined ? undefined : { op: read, args: { userId: person } };
  }
  const company =
    (op.path.includes(':organizationId') ? args['organizationId'] : undefined) ??
    (op.path.startsWith('/v1/platform/organizations/:id/') ? args['id'] : undefined);
  if (typeof company === 'string') {
    const read = findOpByRoute('GET', '/v1/platform/organizations/:organizationId');
    return read === undefined ? undefined : { op: read, args: { organizationId: company } };
  }
  return undefined;
}

const MAX_FIELD_CHARS = 200;

function fieldText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS - 1)}…` : text;
}

/** Arguments that name the action's target, in the order the subject is taken from them. */
const SUBJECT_ARGS = ['title', 'name', 'subject', 'label', 'email', 'fileName', 'poNumber', 'code'];

/** Response keys that name a read target, in preference order. */
const SUBJECT_KEYS = ['title', 'name', 'subject', 'label'];

function firstNamed(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return fieldText(value.trim());
  }
  return null;
}

/** The subject when the arguments carry it (a create, an invite): their first name-like value. */
export function subjectFromArgs(args: Record<string, unknown>): string | null {
  return firstNamed(args, SUBJECT_ARGS);
}

/**
 * The read op that names an action's target: the registry's `GET` on the same path (a delete of
 * `/work-items/:workItemId` → `work_items.get`). Only read-class ops; never the action itself.
 */
export function subjectLookupOp(op: AiActionOp): AiActionOp | undefined {
  if (op.method === 'GET') return undefined;
  const read = findOpByRoute('GET', op.path);
  return read?.risk === 'read' ? read : undefined;
}

/** The target's name from that read's JSON body (top level, or under `data` / `item`). */
export function subjectFromBody(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isRecord(parsed)) return null;
  for (const source of [parsed, parsed['data'], parsed['item']]) {
    if (isRecord(source)) {
      const found = firstNamed(source, SUBJECT_KEYS);
      if (found !== null) return found;
    }
  }
  return null;
}

export function buildApprovalSummary(
  op: AiActionOp,
  detail: AiActionDetail,
  args: Record<string, unknown>,
  subject: string | null = subjectFromArgs(args),
): ApprovalSummary {
  // Every argument that runs is shown (AI tamper review 2026-11-23): a cap here hid the 13th and
  // later fields of the wider ops (`finance.profile.set` has 22) while they still ran. The strict
  // schemas bound how many there can be.
  const fields = Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => ({ name, value: fieldText(value) }));
  return {
    opId: op.id,
    title: detail.title,
    method: op.method,
    destructive: op.method === 'DELETE',
    notifies: detail.notifies,
    subject,
    fields,
    ...(isPlatformOp(op) ? { platform: platformSummaryOf(op, args)! } : {}),
  };
}

/**
 * What the member must do beyond pressing Approve (AI panel gap 3, Fable 5.2 ruling 2026-11-23).
 * `step_up`: a money or HR action. The panel shows "Review", never a one-click Approve, and the
 * server refuses an approve without a fresh step-up (and, for money, the amount typed back).
 */
export type ApprovalConfirmation = 'none' | 'step_up';

/** What one frozen action asks of the approver, from the same gate as the in-app AI's cards. */
export interface ApprovalGate {
  readonly confirmation: ApprovalConfirmation;
  /** The amount the member types back (money), when the frozen arguments name one. */
  readonly amount: number | null;
}

/**
 * The gate of a frozen action, decided by the in-app AI's own rule (`changeGateFor`: money and
 * HR need a step-up, money also the typed amount) so the panel and the chat never disagree
 * (AR-8). Pure.
 */
export function approvalGateOf(op: AiActionOp, args: Record<string, unknown>): ApprovalGate {
  const gate = changeGateFor(op, { runAtOnce: false, hasUndo: false });
  return {
    confirmation: gate?.stepUp === true ? 'step_up' : 'none',
    amount: gate?.typedAmount === true ? amountOf(args, null) : null,
  };
}

/** The approve page's address for one pending action. */
export function approvalUrl(webOrigin: string, orgSlug: string, id: string): string {
  return `${webOrigin.replace(/\/+$/, '')}/${encodeURIComponent(orgSlug)}/ai/approve/${encodeURIComponent(id)}`;
}

/**
 * Sign the approval id into the MRTR `requestState` a retried call carries back. The state is an
 * id plus an HMAC; it proves the server issued it, but it is never an approval by itself — the
 * retry still reads the row's status, which only the approve page can change (`T-APR-04`).
 */
export function signRequestState(id: string, key: string): string {
  const mac = createHmac('sha256', key).update(`pending-ai-action:${id}`).digest('base64url');
  return `${id}.${mac}`;
}

/** The approval id inside a valid `requestState`, or `undefined` for a forged or altered one. */
export function verifyRequestState(state: unknown, key: string): string | undefined {
  if (typeof state !== 'string') return undefined;
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const id = state.slice(0, dot);
  const expected = Buffer.from(signRequestState(id, key));
  const presented = Buffer.from(state);
  if (expected.length !== presented.length) return undefined;
  return timingSafeEqual(expected, presented) ? id : undefined;
}

/**
 * The approval id a retried call is asking about. Only the signed `requestState` (or the explicit
 * `approval_id` of `tmanage_check_approval`) names it. Whatever the client puts in
 * `inputResponses` — a form-mode "accept", a forged URL-mode completion — is deliberately ignored:
 * the client produces that answer, so it is never counted as approval (`T-APR-04`).
 */
export function approvalIdFromRetry(
  retry: { readonly requestState?: unknown; readonly inputResponses?: unknown },
  key: string,
): string | undefined {
  return verifyRequestState(retry.requestState, key);
}

export interface ApprovalRequiredInput {
  readonly id: string;
  readonly url: string;
  readonly expiresAt: Date;
  readonly title: string;
  /** The client declared URL-mode elicitation support. */
  readonly supportsUrlElicitation: boolean;
  readonly requestState: string;
}

/** The plain-text sentence both answers carry, so a model that only reads text still has the link. */
export function approvalMessage(title: string, url: string): string {
  return `"${title}" needs your approval before it runs. Open this link in TManage, signed in as yourself, and approve it there: ${url}`;
}

/** The structured `status: "pending"` answer every approval channel returns. Nothing has run. */
export function pendingApproval(
  input: Pick<ApprovalRequiredInput, 'id' | 'url' | 'expiresAt'>,
): Record<string, string> {
  return {
    status: 'pending',
    approval_id: input.id,
    approval_url: input.url,
    expires_at: input.expiresAt.toISOString(),
  };
}

/**
 * The answer to an AI client that asked for a confirm-class op (architecture F3). With URL-mode
 * elicitation the server returns an MRTR `input_required` result naming the approve page;
 * otherwise an ordinary, non-error tool result carries the same link as text with
 * `status: "pending"`. Either way nothing has run.
 */
export function approvalRequiredResult(input: ApprovalRequiredInput): Record<string, unknown> {
  const message = approvalMessage(input.title, input.url);
  const pending = pendingApproval(input);
  if (input.supportsUrlElicitation) {
    return {
      resultType: 'input_required',
      inputRequests: {
        approval: {
          method: 'elicitation/create',
          params: { mode: 'url', elicitationId: input.id, url: input.url, message },
        },
      },
      requestState: input.requestState,
      content: [{ type: 'text', text: message }],
      structuredContent: pending,
    };
  }
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: pending,
    isError: false,
  };
}

/** Cap a stored op result so `check_approval` never returns more than {@link MAX_RESULT_BYTES}. */
export function capResult(body: string): unknown {
  if (body.length === 0) return null;
  if (Buffer.byteLength(body, 'utf8') > MAX_RESULT_BYTES) return { truncated: true };
  try {
    return JSON.parse(body);
  } catch {
    return { text: body.slice(0, 2000) };
  }
}
