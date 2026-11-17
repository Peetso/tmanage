import { randomUUID } from 'node:crypto';
import { authorize, uuidv7 } from '@tmanage/domain';
import type { AuditAction, Capability, Principal } from '@tmanage/domain';
import type { Mailer } from '@tmanage/mail';
import type { PublicLinkRow } from '../../common/database/schema.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PublicLinkSecrets } from './public-link-secrets.js';
import { KIND_CAPABILITY, PUBLIC_LINK_KINDS } from './public-link-targets.js';
import type {
  PublicLinkKind,
  PublicLinkProjection,
  PublicLinkTargetAdapter,
  PublicLinkTargets,
} from './public-link-targets.js';
import { PublicLinksRepository, type findLinkByTokenHash } from './public-links.repository.js';

/**
 * 56-07 — the one public link system: members issue, list and revoke links; an outsider opens
 * one, asks for an e-mail code and makes the one terminal decision.
 *
 * - The member side runs in the member's own context and authorizes against the TARGET (loaded by
 *   its adapter in that context, so another organization's object is a 404): the kind's
 *   capability to issue, the adapter's manage capability (or `org.security.manage`, or being the
 *   creator) to revoke, `org.security.manage` for the organization-wide list.
 * - The outsider side has no session. The token hash names one link on `bootstrapRead`; every
 *   further read and write runs in a SERVICE context for that link's organization, so the link
 *   reaches exactly its own object. Any unknown or malformed token is the same 404.
 * - Every outsider action is an event row and an audit row (`public_link.opened|decided`).
 * - R23-a (55-14, 56 §5.15): a kind may FORCE its own policy. `magic_signin` is always single use
 *   with a 15-minute expiry — a caller's `expiresInDays`/`maxUses` is ignored, not refused, and the
 *   `public_link.created` audit row says `forced_policy`. An open is counted atomically
 *   (`uses < max_uses`); a consumed magic link answers the same flat 404 as an unknown token, so
 *   a second use cannot tell "used" from "never existed". Every other kind keeps `expired`.
 */

export const DEFAULT_EXPIRY_DAYS = 7;
export const MAX_EXPIRY_DAYS = 30;
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODES_PER_HOUR = 5;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_COMMENT = 1_000;
const MAX_TYPED_NAME = 120;
const MAX_EMAIL = 320;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const LANGUAGES = ['en', 'ar'] as const;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const MAGIC_SIGNIN_TTL_MS = 15 * 60_000;

/** A kind's forced expiry and use limit; `null` = the caller's `expiresInDays`/`maxUses` apply. */
export const KIND_POLICY: Readonly<
  Record<PublicLinkKind, { readonly ttlMs: number | null; readonly maxUses: number | null }>
> = {
  approval: { ttlMs: null, maxUses: null },
  intake: { ttlMs: null, maxUses: null },
  quote: { ttlMs: null, maxUses: null },
  share: { ttlMs: null, maxUses: null },
  magic_signin: { ttlMs: MAGIC_SIGNIN_TTL_MS, maxUses: 1 },
};

export type LinkStatus = 'active' | 'opened' | 'decided' | 'expired' | 'revoked';

export interface PublicLinkView {
  readonly id: string;
  readonly kind: PublicLinkKind;
  readonly targetType: string;
  readonly targetId: string;
  readonly tokenHint: string;
  readonly audienceEmail: string | null;
  readonly requireCode: boolean;
  readonly language: string;
  readonly status: LinkStatus;
  readonly decision: string | null;
  readonly expiresAt: string;
  readonly maxUses: number | null;
  readonly uses: number;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly lastOpenedAt: string | null;
}

/** The create answer: the token is in it exactly once and never again. */
export interface CreatedPublicLink extends PublicLinkView {
  readonly token: string;
}

export type OutsiderLinkView =
  | { readonly state: 'expired' | 'revoked' | 'superseded' }
  | { readonly state: 'decided'; readonly decision: string; readonly decidedAt: string }
  | {
      readonly state: 'active';
      readonly kind: PublicLinkKind;
      readonly organizationName: string;
      readonly language: string;
      readonly decisions: readonly string[];
      readonly codeRequiredFor: readonly string[];
      readonly versionHash: string | null;
      readonly projection: PublicLinkProjection;
      /** 52-18: the audience e-mail masked (`s•••@client.com`) for the watermark; never in full. */
      readonly audienceHint: string | null;
    };

/** What the request tells us about the outsider; only hashes and a capped user agent are kept. */
export interface OutsiderMeta {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface CreateLinkInput {
  readonly kind: PublicLinkKind;
  readonly targetType: string;
  readonly targetId: string;
  readonly audienceEmail: string | null;
  readonly requireCode: boolean;
  readonly language: string;
  readonly expiresInDays: number;
  readonly maxUses: number | null;
}

export type PublicLinkStore = Pick<PublicLinksRepository, keyof PublicLinksRepository>;
export type LinkLookup = typeof findLinkByTokenHash;

export interface PublicLinksServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly lookup: (tokenHash: string, correlationId: string) => ReturnType<LinkLookup>;
  readonly targets: PublicLinkTargets;
  readonly secrets: PublicLinkSecrets;
  readonly audit: Pick<AuditService, 'record'>;
  readonly mailer: Mailer | null;
  readonly store?: PublicLinkStore;
  readonly now?: () => Date;
}

type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; error: ApiError };

export class PublicLinksService {
  private readonly store: PublicLinkStore;
  private readonly now: () => Date;

  constructor(private readonly options: PublicLinksServiceOptions) {
    this.store = options.store ?? new PublicLinksRepository();
    this.now = options.now ?? (() => new Date());
  }

  // ── member side ────────────────────────────────────────────────────────────

  async create(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<CreatedPublicLink> {
    const input = validateCreate(body);
    return this.options.database.transaction(context, (tx) =>
      this.createInTransaction(tx, context, principal, input),
    );
  }

  /**
   * Issue a link inside the caller's own transaction — the entry point for a consumer whose own
   * command creates the link (52-08 "send a quote" creates a `quote` link atomically with it).
   */
  async createInTransaction(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    input: CreateLinkInput,
  ): Promise<CreatedPublicLink> {
    const adapter = this.adapterFor(input.targetType, input.kind);
    const target = await adapter.resolve(tx, context, input.targetId);
    if (target === null) throw notFound('public_link.target_not_visible');
    this.require(principal, KIND_CAPABILITY[input.kind], context, target.projectId);
    const codeNeeded = input.requireCode || (adapter.decisionsRequiringCode?.length ?? 0) > 0;
    if (input.audienceEmail === null && codeNeeded) {
      throw invalid('audienceEmail', 'is required when an e-mail code is required');
    }
    const at = this.now();
    const policy = KIND_POLICY[input.kind];
    const forced = policy.ttlMs !== null || policy.maxUses !== null;
    const secret = this.options.secrets.issueToken();
    const row: PublicLinkRow = {
      id: uuidv7(),
      organizationId: context.organizationId,
      kind: input.kind,
      tokenHash: secret.hash,
      tokenHint: secret.hint,
      targetType: adapter.targetType,
      targetId: input.targetId,
      versionHash: target.versionHash,
      audienceEmail: input.audienceEmail,
      requireCode: input.requireCode,
      language: input.language,
      expiresAt: new Date(at.getTime() + (policy.ttlMs ?? input.expiresInDays * DAY_MS)),
      maxUses: policy.maxUses ?? input.maxUses,
      uses: 0,
      decision: null,
      decidedAt: null,
      createdByUserId: context.userId,
      createdAt: at,
      revokedAt: null,
      revokedByUserId: null,
      lastOpenedAt: null,
    };
    await this.store.insert(tx, context, row);
    const extra = forced ? { forced_policy: input.kind } : {};
    await this.audited(tx, context, 'public_link.created', row, extra, context.userId);
    return { ...toView(row, at), token: secret.token };
  }

  async list(
    context: TenantContext,
    principal: Principal,
    query: { readonly targetType?: unknown; readonly targetId?: unknown },
  ): Promise<readonly PublicLinkView[]> {
    const at = this.now();
    if (query.targetType === undefined && query.targetId === undefined) {
      this.requireSecurityManage(principal, context);
      const rows = await this.options.database.read(context, (r) =>
        this.store.list(r, context, null),
      );
      return rows.map((row) => toView(row, at));
    }
    const adapter = this.options.targets.get(query.targetType);
    if (adapter === null) throw invalid('targetType', 'is not a known link target');
    if (typeof query.targetId !== 'string' || !UUID_SHAPE.test(query.targetId)) {
      throw invalid('targetId', 'must be a UUID');
    }
    const targetId = query.targetId;
    const rows = await this.options.database.read(context, async (r) => {
      const target = await adapter.resolve(r, context, targetId);
      if (target === null) throw notFound('public_link.target_not_visible');
      this.require(principal, adapter.manageCapability, context, target.projectId);
      return this.store.list(r, context, { targetType: adapter.targetType, targetId });
    });
    return rows.map((row) => toView(row, at));
  }

  async revoke(context: TenantContext, principal: Principal, linkId: string): Promise<void> {
    if (!UUID_SHAPE.test(linkId)) throw notFound('public_link.not_visible');
    await this.options.database.transaction(context, async (tx) => {
      const link = await this.store.findById(tx, context, linkId, true);
      if (link === null) throw notFound('public_link.not_visible');
      const adapter = this.options.targets.get(link.targetType);
      const target = adapter ? await adapter.resolve(tx, context, link.targetId) : null;
      const projectId = target?.projectId ?? null;
      const allowed =
        allows(principal, 'org.security.manage', context, null) ||
        (adapter !== null &&
          target !== null &&
          (allows(principal, adapter.manageCapability, context, projectId) ||
            (link.createdByUserId === context.userId &&
              allows(
                principal,
                KIND_CAPABILITY[link.kind as PublicLinkKind],
                context,
                projectId,
              ))));
      if (!allowed) throw notFound('public_link.revoke_denied');
      if (!(await this.revokeInTransaction(tx, context, link))) {
        throw new ApiError(409, 'conflict', 'This link is already revoked or decided.');
      }
    });
  }

  /**
   * The one revoke path (56-07p's bulk revoke uses it too): stamp `revoked_at` on a live link and
   * write its audit row. The caller has authorized and holds the row lock; false = it was already
   * revoked or decided. From this commit on, `open` answers `revoked` — there is no cache to clear.
   */
  async revokeInTransaction(
    tx: TenantQueryRunner,
    context: TenantContext,
    link: PublicLinkRow,
  ): Promise<boolean> {
    if (!(await this.store.revoke(tx, context, link.id, this.now()))) return false;
    await this.audited(tx, context, 'public_link.revoked', link, {}, context.userId);
    return true;
  }

  /** One link of the context's organization, locked for the rest of the transaction. */
  async findForUpdate(
    tx: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
  ): Promise<PublicLinkRow | null> {
    return this.store.findById(tx, context, linkId, true);
  }

  // ── outsider side ──────────────────────────────────────────────────────────

  async open(token: unknown, meta: OutsiderMeta): Promise<OutsiderLinkView> {
    return this.outsider(token, async (tx, context, link) => {
      const at = this.now();
      if (consumed(link, at)) throw notFound('public_link.unknown_token');
      const state = terminalState(link, at);
      if (state !== null) return state;
      const adapter = this.options.targets.get(link.targetType);
      const target = adapter ? await adapter.resolve(tx, context, link.targetId) : null;
      if (adapter === null || target === null) return { state: 'expired' };
      if (link.versionHash !== null && target.versionHash !== link.versionHash) {
        return { state: 'superseded' };
      }
      // Counted before anything is shown: false = a parallel open used the last use first.
      if (!(await this.store.recordOpen(tx, context, link.id, at))) {
        if (link.kind === 'magic_signin') throw notFound('public_link.unknown_token');
        return { state: 'expired' };
      }
      await this.event(tx, context, link, 'opened', null, meta);
      await this.audited(tx, context, 'public_link.opened', link, {}, null);
      return {
        state: 'active',
        kind: link.kind as PublicLinkKind,
        organizationName: await this.store.organizationName(tx, context),
        language: link.language,
        decisions: adapter.decisions,
        codeRequiredFor: link.requireCode
          ? adapter.decisions
          : (adapter.decisionsRequiringCode ?? []),
        versionHash: link.versionHash,
        projection: target.projection,
        audienceHint: maskEmail(link.audienceEmail),
      };
    });
  }

  /** Mail a fresh 6-digit code to the link's audience e-mail. The address is never echoed. */
  async sendCode(
    token: unknown,
    meta: OutsiderMeta,
  ): Promise<{ readonly expiresInSeconds: number }> {
    const sent = await this.outsider(token, async (tx, context, link) => {
      const at = this.now();
      if (consumed(link, at)) return fail(notFound('public_link.unknown_token'));
      const state = terminalState(link, at);
      if (state !== null) return fail(unusable(state.state));
      if (link.audienceEmail === null) {
        return fail(new ApiError(409, 'conflict', 'This link does not use an e-mail code.'));
      }
      const since = new Date(at.getTime() - HOUR_MS);
      if (
        (await this.store.countEventsSince(tx, context, link.id, 'code_sent', since)) >=
        CODES_PER_HOUR
      ) {
        return fail(new ApiError(429, 'rate_limited', 'Too many codes. Try again in an hour.'));
      }
      const code = this.options.secrets.issueCode(link.id);
      await this.store.putCode(tx, context, {
        linkId: link.id,
        codeHash: code.hash,
        expiresAt: new Date(at.getTime() + CODE_TTL_MS),
        createdAt: at,
      });
      await this.event(tx, context, link, 'code_sent', null, meta);
      const organizationName = await this.store.organizationName(tx, context);
      return succeed({ to: link.audienceEmail, code: code.code, organizationName });
    });
    const mail = unwrap(sent);
    if (this.options.mailer !== null) {
      await this.options.mailer.send({
        to: mail.to,
        // EMAILBUILD: the code is never in the subject.
        subject: 'Your TManage code',
        templateKey: 'public_link_code',
        text:
          `Your code for the link ${mail.organizationName} sent you is ${mail.code}.\n\n` +
          'It works for 10 minutes. If you did not open this link, you can ignore this message.',
      });
    }
    return { expiresInSeconds: CODE_TTL_MS / 1_000 };
  }

  /** The one terminal decision, bound to the version hash the outsider was shown. */
  async decide(
    token: unknown,
    body: unknown,
    meta: OutsiderMeta,
  ): Promise<{ readonly state: 'decided'; readonly decision: string; readonly decidedAt: string }> {
    const raw = (body ?? {}) as Record<string, unknown>;
    const outcome = await this.outsider(token, async (tx, context, link) => {
      const at = this.now();
      if (consumed(link, at)) return fail(notFound('public_link.unknown_token'));
      const state = terminalState(link, at);
      if (state !== null) return fail(unusable(state.state));
      const adapter = this.options.targets.get(link.targetType);
      const target = adapter ? await adapter.resolve(tx, context, link.targetId) : null;
      if (adapter === null || target === null) return fail(unusable('expired'));
      const decision = adapter.decisions.find((d) => d === raw['decision']);
      if (decision === undefined)
        return fail(invalid('decision', 'is not a decision this link takes'));
      const bound = link.versionHash;
      if (bound !== null && (raw['versionHash'] !== bound || target.versionHash !== bound)) {
        return fail(
          new ApiError(409, 'conflict', 'A newer version exists.', [
            { field: 'versionHash', message: 'stale' },
          ]),
        );
      }
      const comment = typeof raw['comment'] === 'string' ? raw['comment'].trim() : '';
      if (comment.length > MAX_COMMENT) return fail(invalid('comment', `is over ${MAX_COMMENT}`));
      const typedName = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
      if (typedName.length > MAX_TYPED_NAME) {
        return fail(invalid('name', `is over ${MAX_TYPED_NAME}`));
      }
      const codeNeeded =
        link.requireCode || (adapter.decisionsRequiringCode ?? []).includes(decision);
      if (codeNeeded) {
        const refused = await this.checkCode(tx, context, link, raw['code'], at, meta);
        if (refused !== null) return fail(refused);
      }
      if (!(await this.store.decide(tx, context, link.id, decision, at))) {
        return fail(unusable('decided'));
      }
      const detail = {
        comment: comment === '' ? null : comment,
        typedName: typedName === '' ? null : typedName,
        verified: codeNeeded,
        ipHash: this.options.secrets.ipHash(meta.ip),
        userAgent: meta.userAgent?.slice(0, 255) ?? null,
        decidedAt: at,
      };
      await adapter.onDecision?.(tx, context, link, decision, detail);
      for (const observe of this.options.targets.decisionObservers(link.targetType)) {
        await observe(tx, context, link, decision, detail);
      }
      await this.event(
        tx,
        context,
        link,
        'decided',
        comment === '' ? decision : `${decision}: ${comment}`,
        meta,
      );
      await this.audited(tx, context, 'public_link.decided', link, { decision }, null);
      return succeed({ state: 'decided' as const, decision, decidedAt: at.toISOString() });
    });
    return unwrap(outcome);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Find the link a token names, then run `work` in a service context for its organization. A
   * refusal is RETURNED, not thrown, so a counted wrong code commits before the 400 goes out.
   */
  private async outsider<T>(
    token: unknown,
    work: (tx: TenantQueryRunner, context: TenantContext, link: PublicLinkRow) => Promise<T>,
  ): Promise<T> {
    const hash = this.options.secrets.hashPresented(token);
    const correlationId = randomUUID();
    const found = hash === null ? null : await this.options.lookup(hash, correlationId);
    if (found === null) throw notFound('public_link.unknown_token');
    const context = createServiceContext({
      organizationId: found.organizationId,
      correlationId,
      policyVersion: 'public-link',
    });
    return this.options.database.transaction(context, async (tx) => {
      const link = await this.store.findById(tx, context, found.id, true);
      if (link === null) throw notFound('public_link.unknown_token');
      return work(tx, context, link);
    });
  }

  private async checkCode(
    tx: TenantQueryRunner,
    context: TenantContext,
    link: PublicLinkRow,
    presented: unknown,
    at: Date,
    meta: OutsiderMeta,
  ): Promise<ApiError | null> {
    const stored = await this.store.findCode(tx, context, link.id);
    const refuse = () => invalid('code', 'is wrong or has expired; ask for a new one');
    if (stored === null || stored.expiresAt <= at || stored.attempts >= CODE_MAX_ATTEMPTS) {
      return refuse();
    }
    if (!this.options.secrets.codeMatches(link.id, presented, stored.codeHash)) {
      await this.store.countCodeAttempt(tx, context, link.id);
      await this.event(tx, context, link, 'refused', 'wrong code', meta);
      return refuse();
    }
    await this.store.deleteCode(tx, context, link.id);
    await this.event(tx, context, link, 'code_ok', null, meta);
    return null;
  }

  private async event(
    tx: TenantQueryRunner,
    context: TenantContext,
    link: PublicLinkRow,
    kind: string,
    detail: string | null,
    meta: OutsiderMeta,
  ): Promise<void> {
    await this.store.appendEvent(tx, context, {
      id: uuidv7(),
      linkId: link.id,
      kind,
      detail,
      ipHash: this.options.secrets.ipHash(meta.ip),
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
      createdAt: this.now(),
    });
  }

  private async audited(
    tx: TenantQueryRunner,
    context: TenantContext,
    action: AuditAction,
    link: PublicLinkRow,
    extra: Readonly<Record<string, string>>,
    actorUserId: string | null,
  ): Promise<void> {
    await this.options.audit.record(tx, context, {
      action,
      result: 'allowed',
      objectId: link.id,
      actorUserId,
      metadata: { link_kind: link.kind, target_type: link.targetType, ...extra },
    });
  }

  private adapterFor(targetType: string, kind: PublicLinkKind): PublicLinkTargetAdapter {
    const adapter = this.options.targets.get(targetType);
    if (adapter === null || !adapter.kinds.includes(kind)) {
      throw invalid('targetType', `does not take ${kind} links`);
    }
    return adapter;
  }

  private require(
    principal: Principal,
    capability: Capability,
    context: TenantContext,
    projectId: string | null,
  ): void {
    if (!allows(principal, capability, context, projectId))
      throw notFound(`public_link.${capability}`);
  }

  private requireSecurityManage(principal: Principal, context: TenantContext): void {
    if (!allows(principal, 'org.security.manage', context, null)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'public_link.list_all');
    }
  }
}

function allows(
  principal: Principal,
  capability: Capability,
  context: TenantContext,
  projectId: string | null,
): boolean {
  return authorize({
    principal,
    capability,
    resource: {
      organizationId: context.organizationId,
      projectId,
      audience: projectId === null ? 'internal' : 'client_visible',
      lifecycle: 'active',
    },
  }).allowed;
}

/** `sara@client.com` → `s•••@client.com`; the domain stays so the approver recognises it. */
export function maskEmail(email: string | null): string | null {
  if (email === null) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

export function linkStatus(row: PublicLinkRow, at: Date): LinkStatus {
  if (row.revokedAt !== null) return 'revoked';
  if (row.decision !== null) return 'decided';
  if (row.expiresAt <= at || (row.maxUses !== null && row.uses >= row.maxUses)) return 'expired';
  return row.lastOpenedAt === null ? 'active' : 'opened';
}

/** A used-up `magic_signin` link: it must answer exactly like a token that never existed. */
function consumed(row: PublicLinkRow, at: Date): boolean {
  return (
    row.kind === 'magic_signin' &&
    linkStatus(row, at) === 'expired' &&
    row.maxUses !== null &&
    row.uses >= row.maxUses
  );
}

function terminalState(row: PublicLinkRow, at: Date): OutsiderLinkView | null {
  const status = linkStatus(row, at);
  if (status === 'revoked' || status === 'expired') return { state: status };
  if (status === 'decided') {
    return {
      state: 'decided',
      decision: row.decision ?? '',
      decidedAt: (row.decidedAt ?? at).toISOString(),
    };
  }
  return null;
}

export function toView(row: PublicLinkRow, at: Date): PublicLinkView {
  return {
    id: row.id,
    kind: row.kind as PublicLinkKind,
    targetType: row.targetType,
    targetId: row.targetId,
    tokenHint: row.tokenHint,
    audienceEmail: row.audienceEmail,
    requireCode: row.requireCode,
    language: row.language,
    status: linkStatus(row, at),
    decision: row.decision,
    expiresAt: row.expiresAt.toISOString(),
    maxUses: row.maxUses,
    uses: row.uses,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
  };
}

export function validateCreate(raw: unknown): CreateLinkInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const kind = PUBLIC_LINK_KINDS.find((k) => k === body['kind']);
  if (kind === undefined) throw invalid('kind', `must be one of ${PUBLIC_LINK_KINDS.join(', ')}`);
  const targetType = body['targetType'];
  if (typeof targetType !== 'string' || targetType === '')
    throw invalid('targetType', 'is required');
  const targetId = body['targetId'];
  if (typeof targetId !== 'string' || !UUID_SHAPE.test(targetId)) {
    throw invalid('targetId', 'must be a UUID');
  }
  let audienceEmail: string | null = null;
  if (body['audienceEmail'] !== undefined && body['audienceEmail'] !== null) {
    const email = typeof body['audienceEmail'] === 'string' ? body['audienceEmail'].trim() : '';
    if (email.length > MAX_EMAIL || !EMAIL_SHAPE.test(email)) {
      throw invalid('audienceEmail', 'must be an e-mail address');
    }
    audienceEmail = email.toLowerCase();
  }
  const days = body['expiresInDays'] ?? DEFAULT_EXPIRY_DAYS;
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > MAX_EXPIRY_DAYS) {
    throw invalid('expiresInDays', `must be a whole number from 1 to ${MAX_EXPIRY_DAYS}`);
  }
  const maxUses = body['maxUses'] ?? null;
  if (maxUses !== null && (!Number.isInteger(maxUses) || (maxUses as number) < 1)) {
    throw invalid('maxUses', 'must be a positive whole number');
  }
  const language = LANGUAGES.find((l) => l === (body['language'] ?? 'en'));
  if (language === undefined) throw invalid('language', 'must be en or ar');
  return {
    kind,
    targetType,
    targetId,
    audienceEmail,
    requireCode: body['requireCode'] === true,
    language,
    expiresInDays: days as number,
    maxUses: maxUses as number | null,
  };
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

function notFound(auditCode: string): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, auditCode);
}

function unusable(state: string): ApiError {
  return new ApiError(409, 'conflict', 'This link can no longer be used.', [
    { field: 'state', message: state },
  ]);
}

function succeed<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

function fail(error: ApiError): Outcome<never> {
  return { ok: false, error };
}

function unwrap<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
