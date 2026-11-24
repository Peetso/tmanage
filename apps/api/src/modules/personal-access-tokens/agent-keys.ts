import { AI_AGENT_KEY_LIFETIME_DAYS } from '@tmanage/domain';
import type { PersonalAccessTokenRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { validateIpAllowlist } from '../admin/cidr.js';
import { SCOPE_AGENT } from '../oauth/scopes.js';
import { mintPersonalAccessToken, parseStoredIpAllowlist } from './personal-access-token.js';
import { PersonalAccessTokensRepository } from './personal-access-tokens.repository.js';

/**
 * 60-05 (plan 60 v2 §4.5) — agent keys: personal access tokens whose membership is an AI
 * employee's. This module owns `personal_access_tokens`, so the AI-employee service (the Tenancy &
 * People context) reaches them through this service, never the table (AR-5, AR-7). Every method
 * runs in the caller's transaction, so the authorization, the cap check and the audit row commit
 * with the write (DA-1, DA-11).
 *
 * The rules, all here:
 * - scope: only `tmanage:agent` (never a human scope; see `SCOPE_AGENT`);
 * - expiry: mandatory, one of 30 / 60 / 90 days (`AI_AGENT_KEY_LIFETIME_DAYS`);
 * - optional IP allowlist, validated like a person's token (`admin/cidr.ts`);
 * - shown once: the plaintext leaves only in the create / rotate answer, the hash is stored;
 * - rotate: a new key, and the old one ends no later than 24 hours from now;
 * - revoke: immediate.
 */

export const AGENT_KEY_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NAME_MAX = 190;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;

export interface AgentKeyRequest {
  readonly name: string;
  readonly lifetimeDays: (typeof AI_AGENT_KEY_LIFETIME_DAYS)[number];
  /** JSON list of addresses / CIDR ranges, or null for any address. */
  readonly ipAllowlistJson: string | null;
}

export type AgentKeyParse =
  | { readonly ok: true; readonly value: AgentKeyRequest }
  | { readonly ok: false; readonly issues: readonly { field: string; message: string }[] };

/** Parse a create / rotate body: `{ name, lifetimeDays: 30|60|90, ipAllowlist?: string[] }`. */
export function parseAgentKeyRequest(input: unknown): AgentKeyParse {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, issues: [{ field: 'body', message: 'must be an object' }] };
  }
  const body = input as Record<string, unknown>;
  const issues: { field: string; message: string }[] = [];
  const known = new Set(['name', 'lifetimeDays', 'ipAllowlist']);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) issues.push({ field: key, message: 'is not a field of an agent key' });
  }
  const rawName = body['name'];
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (name.length === 0 || name.length > NAME_MAX) {
    issues.push({ field: 'name', message: `must be 1 to ${NAME_MAX} characters` });
  } else if (CONTROL.test(name)) {
    issues.push({ field: 'name', message: 'must not contain hidden or control characters' });
  }
  const days = body['lifetimeDays'];
  const lifetimeDays = AI_AGENT_KEY_LIFETIME_DAYS.find((allowed) => allowed === days);
  if (lifetimeDays === undefined) {
    issues.push({
      field: 'lifetimeDays',
      message: `must be one of ${AI_AGENT_KEY_LIFETIME_DAYS.join(', ')}`,
    });
  }
  let ipAllowlistJson: string | null = null;
  const allowlist = body['ipAllowlist'];
  if (allowlist !== undefined && allowlist !== null) {
    const verdict = validateIpAllowlist(allowlist);
    if (!verdict.ok) issues.push({ field: 'ipAllowlist', message: verdict.message });
    else ipAllowlistJson = verdict.value.length === 0 ? null : JSON.stringify(verdict.value);
  }
  if (issues.length > 0 || lifetimeDays === undefined) return { ok: false, issues };
  return { ok: true, value: { name, lifetimeDays, ipAllowlistJson } };
}

/** One agent key as the AI-employee screens list it. No hash, no plaintext, no prefix secret. */
export interface AgentKeyView {
  readonly id: string;
  readonly name: string;
  /** The display hint (`tmanage_pat_a1b2…`), so a person can tell keys apart. */
  readonly tokenPrefix: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdByMembershipId: string | null;
  readonly ipAllowlist: readonly string[];
  /** AR-9: live now (not revoked, not past its end). */
  readonly live: boolean;
}

export interface CreatedAgentKeyView extends AgentKeyView {
  /** The plaintext. Present only in this answer; never stored, logged or shown again. */
  readonly token: string;
}

function isLive(row: PersonalAccessTokenRow, at: Date): boolean {
  return row.revokedAt === null && (row.expiresAt === null || row.expiresAt > at);
}

export function agentKeyView(row: PersonalAccessTokenRow, at: Date): AgentKeyView {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdByMembershipId: row.createdByMembershipId ?? null,
    ipAllowlist: parseStoredIpAllowlist(row.ipAllowlistJson),
    live: isLive(row, at),
  };
}

/** The AI employee's membership a key is bound to, as the caller has already authorized it. */
export interface AgentKeyOwner {
  readonly membershipId: string;
  readonly userId: string;
}

export class AgentKeysService {
  constructor(
    private readonly tokens: Pick<
      PersonalAccessTokensRepository,
      | 'listForMembership'
      | 'findForMembership'
      | 'insert'
      | 'revoke'
      | 'endNoLaterThan'
      | 'countLiveForMembership'
    > = new PersonalAccessTokensRepository(),
  ) {}

  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    owner: AgentKeyOwner,
    at: Date,
  ): Promise<readonly AgentKeyView[]> {
    const rows = await this.tokens.listForMembership(runner, context, owner.membershipId);
    return rows.map((row) => agentKeyView(row, at));
  }

  countLive(
    runner: TenantQueryRunner,
    context: TenantContext,
    owner: AgentKeyOwner,
    at: Date,
  ): Promise<number> {
    return this.tokens.countLiveForMembership(runner, context, owner.membershipId, at);
  }

  async mint(
    runner: TenantQueryRunner,
    context: TenantContext,
    owner: AgentKeyOwner,
    request: AgentKeyRequest,
    createdByMembershipId: string,
    at: Date,
  ): Promise<CreatedAgentKeyView> {
    const minted = mintPersonalAccessToken();
    const row = await this.tokens.insert(runner, context, {
      membershipId: owner.membershipId,
      userId: owner.userId,
      name: request.name,
      tokenHash: minted.tokenHash,
      tokenPrefix: minted.displayPrefix,
      expiresAt: new Date(at.getTime() + request.lifetimeDays * DAY_MS),
      scopes: SCOPE_AGENT,
      ipAllowlistJson: request.ipAllowlistJson,
      createdByMembershipId,
    });
    return { ...agentKeyView(row, at), token: minted.token };
  }

  /** The key, if it is one of this AI employee's (another membership's id is "not found"). */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    owner: AgentKeyOwner,
    keyId: string,
  ): Promise<PersonalAccessTokenRow | null> {
    return (
      (await this.tokens.findForMembership(runner, context, owner.membershipId, keyId)) ?? null
    );
  }

  /** Rotation: end the old key within 24 hours (never later than it already ends). */
  async endWithinOverlap(
    runner: TenantQueryRunner,
    context: TenantContext,
    owner: AgentKeyOwner,
    keyId: string,
    at: Date,
  ): Promise<void> {
    await this.tokens.endNoLaterThan(
      runner,
      context,
      owner.membershipId,
      keyId,
      new Date(at.getTime() + AGENT_KEY_ROTATION_OVERLAP_MS),
    );
  }

  /** Immediate revoke. `false` when the key is not this AI employee's or already revoked. */
  async revoke(
    runner: TenantQueryRunner,
    context: TenantContext,
    owner: AgentKeyOwner,
    keyId: string,
    at: Date,
  ): Promise<boolean> {
    return (await this.tokens.revoke(runner, context, owner.membershipId, keyId, at)) > 0;
  }

  /**
   * Retire: mark every key of this AI employee that is not yet revoked as revoked at `at`, expired
   * ones included, so the rows say what the membership already enforces. Runs in the caller's
   * transaction; returns the ids revoked now (for the audit row).
   */
  async revokeAll(
    runner: TenantQueryRunner,
    context: TenantContext,
    owner: AgentKeyOwner,
    at: Date,
  ): Promise<readonly string[]> {
    const rows = await this.tokens.listForMembership(runner, context, owner.membershipId);
    const revoked: string[] = [];
    for (const row of rows) {
      if (row.revokedAt !== null) continue;
      if ((await this.tokens.revoke(runner, context, owner.membershipId, row.id, at)) > 0) {
        revoked.push(row.id);
      }
    }
    return revoked;
  }
}
