import { createHmac, timingSafeEqual } from 'node:crypto';
import { findOpById, sensitivityOf } from '../ai-actions/registry/index.js';
import { APPROVAL_TTL_SHORT_MS } from '../ai-actions/approval-lifetime.js';
import type { AiActionOp, Sensitivity } from '../ai-actions/registry/index.js';
import { argsSha256 } from '../mcp/internal-grant.js';
import { mcpBodyShapeRefusal } from '../mcp/mcp-body-shape.js';
import { allDetailsById } from '../mcp/tool-catalog.js';
import { changedFields, recordOf } from './ai-undo.js';
import type { CardWarning } from './packs/billing.js';

/**
 * 62-11 (plan 62 §4.3), part 1 — the gate of one AI-proposed change, decided once from the op's
 * risk and sensitivity and the owner's "run at once" setting (AR-8: one decision, one place).
 *
 * - Every change is two-step by default: a preview card the same member confirms.
 * - **Run at once** (owner setting, default off) skips the card only for a `write`-class op with
 *   sensitivity `none` that has an undo. `confirm`-class ops always ask.
 * - `external` and `destructive` always show a card.
 * - Owner 2026-11-23: a turn runs with the member's full rights (`chatScopesFor`), so an op of
 *   scope `manage` or `billing`, and every `DELETE`, also always shows a card, whatever its
 *   sensitivity: "run at once" covers only everyday `write`-scope changes.
 * - `money` and `hr` also need a fresh step-up, the amount typed by the member (money) and the
 *   workspace's approval rule; they are never run at once and never confirmed by voice (62-16).
 * - ADR-0015 F5: a platform op marked `freshReauth` also needs the fresh step-up (no typed amount,
 *   no workspace approval rule).
 * - An op without an undo says "cannot be undone" on its card.
 *
 * Part 2 adds the card itself ({@link buildCardItem}: built by server code from the registry, the
 * validated arguments and the target's current values, never worded by the model) and the signed
 * card ({@link signCard}): the frozen arguments and their hash, bound to the task, the member and
 * a 10-minute expiry, so the confirm runs exactly what the card showed.
 */

export interface AiChangeGate {
  readonly sensitivity: Sensitivity;
  /** A preview card the member confirms before anything runs. */
  readonly card: boolean;
  readonly stepUp: boolean;
  /** The member types the amount the card shows (money only). */
  readonly typedAmount: boolean;
  /** The workspace's approval rule applies (money and HR). */
  readonly approvalRule: boolean;
  /** The card says the change cannot be undone. */
  readonly cannotBeUndone: boolean;
}

export interface AiChangeGateInput {
  /** `ai_workspace_settings.run_at_once` (owner setting). */
  readonly runAtOnce: boolean;
  /** The op declares an inverse (62-11 part 2, `ai-undo.ts`). */
  readonly hasUndo: boolean;
}

/** The gate of one change, or `null` for a read (reads never need one). */
export function changeGateFor(
  op: Pick<AiActionOp, 'id' | 'risk' | 'scope' | 'method' | 'freshReauth'>,
  input: AiChangeGateInput,
): AiChangeGate | null {
  if (op.risk === 'read') return null;
  const sensitivity = sensitivityOf(op);
  const sensitive = sensitivity === 'money' || sensitivity === 'hr';
  const runsAtOnce =
    input.runAtOnce &&
    input.hasUndo &&
    op.risk === 'write' &&
    op.scope === 'write' &&
    op.method !== 'DELETE' &&
    sensitivity === 'none';
  return {
    sensitivity,
    card: !runsAtOnce,
    // ADR-0015 F5: the riskiest platform changes ask for the password again, like money and HR.
    stepUp: sensitive || op.freshReauth === true,
    typedAmount: sensitivity === 'money',
    approvalRule: sensitive,
    cannotBeUndone: !input.hasUndo,
  };
}

/** A change the AI proposed, validated: what a card shows and a confirm runs. */
export interface ValidatedChange {
  readonly op: AiActionOp;
  readonly title: string;
  readonly args: Record<string, unknown>;
  readonly argsSha256: string;
}

/**
 * Validate a proposed change against the op's strict schema (unknown keys refused, the oversized
 * collection guard first); the parsed arguments, not the raw ones, are what is frozen and run.
 * `null` for an unknown op, a read, or invalid arguments.
 */
export function validateChange(opId: string, rawArgs: unknown): ValidatedChange | null {
  const op = findOpById(opId);
  const detail = allDetailsById.get(opId);
  if (op === undefined || detail === undefined || op.risk === 'read') return null;
  if (mcpBodyShapeRefusal(rawArgs) !== undefined) return null;
  const parsed = detail.input.safeParse(rawArgs ?? {});
  if (!parsed.success) return null;
  const args = parsed.data as Record<string, unknown>;
  return { op, title: detail.title, args, argsSha256: argsSha256({ opId, args }) };
}

/**
 * The fields one card lists. 24 (was 12): the platform admin changes of ADR-0015 part 2 (settings,
 * incidents, announcements) carry more than 12; a change with more than this is refused, not
 * shown partly (AI tamper review 2026-11-23). `platform-admin-ai.test.ts` holds every platform
 * change input within it.
 */
export const MAX_CARD_FIELDS = 24;
const MAX_VALUE_CHARS = 200;

/** One line of a card: a field, its value now (when the target was read) and after the change. */
export interface CardChange {
  readonly field: string;
  readonly before: string | null;
  readonly after: string;
}

/** One change on a card (several writes in one turn = one batch card). */
export interface CardItem {
  readonly index: number;
  readonly opId: string;
  readonly title: string;
  readonly sensitivity: Sensitivity;
  /** The target's name, when the arguments or the read of the target name it. */
  readonly subject: string | null;
  readonly changes: readonly CardChange[];
  readonly stepUp: boolean;
  readonly typedAmount: boolean;
  /** The amount the member types back (money), when the card can name it. */
  readonly amount: number | null;
  readonly cannotBeUndone: boolean;
  /** A confirm-class op frozen in `pending_ai_actions` (10 minutes). */
  readonly approvalId: string | null;
  /** 62-29: what the member should see before confirming (a likely duplicate expense). */
  readonly warnings: readonly CardWarning[];
}

function valueText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…` : text;
}

const SUBJECT_KEYS = ['title', 'name', 'subject', 'label', 'email'];
const AMOUNT_KEY = /(amount|total|price|rate)/i;

function firstText(record: Readonly<Record<string, unknown>> | null): string | null {
  if (record === null) return null;
  for (const key of SUBJECT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return valueText(value.trim());
  }
  return null;
}

/**
 * The amount a money change moves: its first numeric amount-like argument, else the target's.
 * `null` when neither names one — such a change cannot be confirmed from the chat (fail closed).
 */
export function amountOf(
  args: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>> | null,
): number | null {
  for (const source of [args, current ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (AMOUNT_KEY.test(key) && typeof value === 'number' && Number.isFinite(value)) return value;
    }
  }
  return null;
}

/** The card line of one validated change, from the target's current values (or `null`). */
export function buildCardItem(
  index: number,
  change: ValidatedChange,
  gate: AiChangeGate,
  currentBody: unknown,
  approvalId: string | null,
  /** 62-29: the amount an op's own rule decided (`billingCardAmount`), and the warnings. */
  decided: {
    readonly amount?: number | null;
    readonly warnings?: readonly CardWarning[];
  } = {},
): CardItem {
  const current = currentBody === null ? null : recordOf(currentBody);
  const fields = changedFields(change.op, change.args).slice(0, MAX_CARD_FIELDS);
  return {
    index,
    opId: change.op.id,
    title: change.title,
    sensitivity: gate.sensitivity,
    subject: firstText(change.args) ?? firstText(current),
    changes: fields.map((field) => ({
      field,
      before: current !== null && field in current ? valueText(current[field]) : null,
      after: valueText(change.args[field]),
    })),
    stepUp: gate.stepUp,
    typedAmount: gate.typedAmount,
    amount: gate.typedAmount
      ? decided.amount !== undefined
        ? decided.amount
        : amountOf(change.args, current)
      : null,
    cannotBeUndone: gate.cannotBeUndone,
    approvalId,
    warnings: decided.warnings ?? [],
  };
}

/**
 * How long an in-app card waits for the member's confirm. Fix 6 (2026-11-23): 30 minutes (was 10).
 * A card can carry a manage, billing, money or removal change, so it takes the SHORT approval
 * lifetime (`APPROVAL_TTL_SHORT_MS`), and so it never outlives a pending action frozen on it (those
 * live 30 minutes or 24 hours, `approval-lifetime.ts`).
 */
export const AI_CARD_TTL_MS = APPROVAL_TTL_SHORT_MS;

/** At most this many changes on one card; the model is told the rest were not proposed. */
export const MAX_CARD_ITEMS = 10;

/** One frozen change of a card: the op, its parsed arguments and their hash. */
export interface CardPayloadItem {
  readonly opId: string;
  readonly args: Record<string, unknown>;
  readonly argsSha256: string;
  readonly approvalId: string | null;
}

/** What is frozen into the signed card, bound to the task, the member and an expiry. */
export interface CardPayload {
  readonly v: 1;
  readonly cardId: string;
  readonly taskId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly expiresAt: number;
  readonly items: readonly CardPayloadItem[];
}

const CARD_PURPOSE = 'tmanage-ai-card:v1';
const MAX_CARD_TOKEN_CHARS = 256 * 1024;

function cardMac(body: string, key: string): string {
  return createHmac('sha256', key).update(`${CARD_PURPOSE}\n${body}`).digest('base64url');
}

/** The card the confirm sends back: the payload and an HMAC over it. Proves issue, not consent. */
export function signCard(payload: CardPayload, key: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${cardMac(body, key)}`;
}

/** The payload of a card this server signed, or `null` (forged, altered or malformed). */
export function verifyCard(token: unknown, key: string): CardPayload | null {
  if (typeof token !== 'string' || token.length > MAX_CARD_TOKEN_CHARS) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const expected = Buffer.from(cardMac(body, key));
  const presented = Buffer.from(token.slice(dot + 1));
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CardPayload;
    return payload?.v === 1 && Array.isArray(payload.items) ? payload : null;
  } catch {
    return null;
  }
}
