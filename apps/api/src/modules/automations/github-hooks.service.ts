import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { authorize, formatWorkKey, parseWorkKeys, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import type { FieldCipher } from '@tmanage/domain/field-cipher';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { CodeLinkKind, GithubRepoHookRow } from '../../common/database/schema.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
import { IntegrationConnectionsRepository } from './directory.repository.js';
import { WorkKeysRepository } from '../work/work-keys.repository.js';
import type { NewCodeLink } from '../work/work-keys.repository.js';
import type { GithubHooksRepository } from './github-hooks.repository.js';

/**
 * R16-e (54-10 GitHub Phase 0) — pasted repository webhooks.
 *
 * Managing (`org.manage`, the stand-in for the plan's `integration.manage`): add one webhook per
 * repository, list, remove, rotate. The HMAC secret is 32 random bytes, returned exactly twice in
 * its life (create, rotate), stored only as a FieldCipher envelope (`integration_token`, AAD =
 * hook id) and never projected or audited. The projects a key may resolve in are frozen at
 * creation: those the creator could read then (<= 20).
 *
 * Inbound (`POST /v1/public/integrations/github/:hookId`, no session):
 *
 * 1. The hook is found on `bootstrapRead(['github_repo_hooks'])`; everything after runs under a
 *    service context bound to the hook's organization. An unknown hook and a bad signature are the
 *    same bodiless 401.
 * 2. `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(secret, raw body), compared with
 *    `timingSafeEqual` over the exact bytes received.
 * 3. One transaction with the hook row locked: a delivery id already seen is 202 with no write
 *    (replay); more than 600 accepted events in the hook's hour is 429; then the delivery id is
 *    recorded (ids older than 7 days are dropped) and the event applied.
 * 4. `push`, `pull_request`, `create`, `delete` link or unlink branches / commits / pull requests
 *    by key, only inside the hook's non-archived projects; unknown keys are ignored; at most 10
 *    keys per event. A payload for another repository than the hook's is ignored. `ping` is 204.
 *
 * Phase 1 (GitHub App, status moves on merge) is not here: no automation is triggered.
 */

export const GITHUB_EVENTS_PER_HOUR = 600;
export const GITHUB_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_HOOK_PROJECTS = 20;
const HOUR_MS = 60 * 60 * 1000;
const MAX_TITLE = 500;
const MAX_KEYS_PER_EVENT = 10;
const MAX_LINKS_PER_EVENT = 50;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const HOOK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SERVICE_POLICY = 'github-inbound';
const BOOTSTRAP_REASON =
  'resolving which organization a GitHub repository webhook belongs to (hook id is a global UUID; the organization comes from the hook row)';

/** What a caller sees of one hook. There is no secret field of any kind. */
export interface GithubHookView {
  readonly id: string;
  readonly connectionId: string;
  readonly repoFullName: string;
  readonly projectIds: readonly string[];
  readonly status: string;
  readonly lastEventAt: string | null;
  readonly createdAt: string;
}

/** The one response that carries the secret: create and rotate. */
export interface GithubHookSecretView extends GithubHookView {
  readonly secret: string;
  readonly webhookUrl: string;
}

export function parseProjectIds(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** An explicit projection: a column added later is invisible until named here. */
export function toGithubHookView(row: GithubRepoHookRow): GithubHookView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    repoFullName: row.repoFullName,
    projectIds: parseProjectIds(row.projectIdsJson),
    status: row.status,
    lastEventAt: row.lastEventAt ? row.lastEventAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `sha256=<hex>` over the exact bytes received, compared in constant time. */
export function verifyGithubSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/u.test(header)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface InboundDelivery {
  readonly hookId: string;
  readonly rawBody: Buffer | undefined;
  readonly signature: string | undefined;
  readonly deliveryId: string | undefined;
  readonly event: string | undefined;
  readonly correlationId: string;
}

/** The status the public route answers with; every one is bodiless. */
export type InboundStatus = 202 | 204 | 400 | 401 | 429;

export interface GithubHooksDeps {
  readonly cipher?: FieldCipher;
  readonly audit?: Pick<AuditEventsRepository, 'append'>;
  readonly connections?: Pick<IntegrationConnectionsRepository, 'create'>;
  readonly keys?: WorkKeysRepository;
  readonly publicBaseUrl?: string;
  readonly now?: () => Date;
}

interface LinkCandidate {
  readonly text: string;
  readonly link: Omit<NewCodeLink, 'workItemId' | 'connectionId' | 'repoFullName'>;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const httpsUrl = (value: unknown): string | null => {
  const url = str(value);
  return url !== null && url.startsWith('https://') && url.length <= 2048 ? url : null;
};
const firstLine = (value: string): string => (value.split(/\r?\n/u)[0] ?? '').slice(0, MAX_TITLE);

export class GithubHooksService {
  private readonly cipher: FieldCipher;
  private readonly audit: Pick<AuditEventsRepository, 'append'>;
  private readonly connections: Pick<IntegrationConnectionsRepository, 'create'>;
  private readonly keys: WorkKeysRepository;
  private readonly publicBaseUrl: string;
  private readonly now: () => Date;

  constructor(
    private readonly database: TenantDatabase,
    private readonly hooks: GithubHooksRepository,
    deps: GithubHooksDeps = {},
  ) {
    this.cipher = deps.cipher ?? createFieldCipher(loadFieldCipherKeyring(process.env));
    this.audit = deps.audit ?? new AuditEventsRepository();
    this.connections = deps.connections ?? new IntegrationConnectionsRepository();
    this.keys = deps.keys ?? new WorkKeysRepository();
    this.publicBaseUrl = (deps.publicBaseUrl ?? process.env['API_PUBLIC_URL'] ?? '').replace(
      /\/+$/u,
      '',
    );
    this.now = deps.now ?? (() => new Date());
  }

  // ── Managing ──────────────────────────────────────────────────────────────

  async list(context: TenantContext): Promise<readonly GithubHookView[]> {
    const rows = await this.database.read(context, (runner) => this.hooks.list(runner, context));
    return rows.map(toGithubHookView);
  }

  async create(
    context: TenantContext,
    principal: Principal,
    body: { readonly repoFullName?: unknown; readonly projectIds?: unknown } | undefined,
  ): Promise<GithubHookSecretView> {
    const details: { field: string; message: string }[] = [];
    const repo = str(body?.repoFullName)?.trim() ?? '';
    if (!REPO_PATTERN.test(repo))
      details.push({ field: 'repoFullName', message: "must be 'owner/name'" });
    const rawIds = body?.projectIds;
    const projectIds =
      Array.isArray(rawIds) && rawIds.every((id) => typeof id === 'string' && id !== '')
        ? [...new Set(rawIds as string[])]
        : [];
    if (projectIds.length === 0 || projectIds.length > MAX_HOOK_PROJECTS) {
      details.push({
        field: 'projectIds',
        message: `must be 1 to ${String(MAX_HOOK_PROJECTS)} project ids`,
      });
    }
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // The plan's "resolve only where the connection creator can read", frozen at creation.
    for (const projectId of projectIds) {
      const readable = authorize({
        principal,
        capability: 'work.read',
        resource: {
          organizationId: context.organizationId,
          projectId,
          audience: 'internal',
          lifecycle: 'active',
        },
      }).allowed;
      if (!readable) throw this.unknownProject();
    }
    this.requireCipher();
    const repoFullName = repo.toLowerCase();
    const secret = randomBytes(32).toString('base64url');
    const id = uuidv7();
    const now = this.now();
    const row = await this.database.transaction(context, async (runner) => {
      for (const projectId of projectIds) {
        const project = await this.keys.findProject(runner, context, projectId);
        if (!project || project.archivedAt !== null) throw this.unknownProject();
      }
      if (await this.hooks.findByRepo(runner, context, repoFullName)) {
        throw new ApiError(
          409,
          'conflict',
          'This repository already has a webhook',
          undefined,
          'github_hook_exists',
        );
      }
      const connection =
        (await this.hooks.findConnection(runner, context)) ??
        (await this.connections.create(runner, context, {
          appId: 'github',
          label: 'GitHub',
          status: 'connected',
          // The config holds scalars only: the first repository, as a label. Hooks are the source of truth.
          config: { repos: repoFullName },
          createdBy: context.userId,
        }));
      const created = await this.hooks.insert(
        runner,
        context,
        {
          id,
          connectionId: connection.id,
          repoFullName,
          secretEnc: this.encrypt(secret, id),
          projectIds,
          createdBy: context.userId,
        },
        now,
      );
      await this.audit.append(runner, context, {
        action: 'github_hook.created',
        result: 'allowed',
        objectId: id,
        metadata: { project_count: projectIds.length },
      });
      return created;
    });
    return { ...toGithubHookView(row), secret, webhookUrl: this.webhookUrl(id) };
  }

  async remove(context: TenantContext, id: string): Promise<void> {
    const removed = await this.database.transaction(context, async (runner) => {
      if (!(await this.hooks.findById(runner, context, id))) return false;
      await this.hooks.remove(runner, context, id);
      await this.audit.append(runner, context, {
        action: 'github_hook.removed',
        result: 'allowed',
        objectId: id,
        metadata: {},
      });
      return true;
    });
    if (!removed) throw this.notFound();
  }

  async rotateSecret(context: TenantContext, id: string): Promise<GithubHookSecretView> {
    this.requireCipher();
    const secret = randomBytes(32).toString('base64url');
    const row = await this.database.transaction(context, async (runner) => {
      const existing = await this.hooks.findById(runner, context, id, true);
      if (!existing) throw this.notFound();
      await this.hooks.updateSecret(runner, context, id, this.encrypt(secret, id));
      await this.audit.append(runner, context, {
        action: 'github_hook.secret_rotated',
        result: 'allowed',
        objectId: id,
        metadata: {},
      });
      return existing;
    });
    return { ...toGithubHookView(row), secret, webhookUrl: this.webhookUrl(id) };
  }

  // ── Inbound ───────────────────────────────────────────────────────────────

  async receive(input: InboundDelivery): Promise<InboundStatus> {
    if (!HOOK_ID_PATTERN.test(input.hookId) || input.rawBody === undefined) return 401;
    const found = await this.database.bootstrapRead(
      {
        correlationId: input.correlationId,
        reason: BOOTSTRAP_REASON,
        tables: ['github_repo_hooks'],
      },
      (runner) => this.hooks.findHookOrganization(runner, input.hookId),
    );
    if (!found) return 401;
    const context = createServiceContext({
      organizationId: found.organizationId,
      correlationId: input.correlationId,
      policyVersion: SERVICE_POLICY,
    });
    const hook = await this.database.read(context, (runner) =>
      this.hooks.findById(runner, context, found.id),
    );
    if (!hook) return 401;
    let secret: string;
    try {
      secret = this.cipher.decrypt(hook.secretEnc, {
        purpose: 'integration_token',
        ownerId: hook.id,
      });
    } catch {
      return 401;
    }
    if (!verifyGithubSignature(secret, input.rawBody, input.signature)) return 401;
    if (input.event === 'ping') return 204;
    const deliveryId = input.deliveryId ?? '';
    if (deliveryId === '' || deliveryId.length > 64) return 400;
    let payload: Record<string, unknown>;
    try {
      payload = record(JSON.parse(input.rawBody.toString('utf8')));
    } catch {
      return 400;
    }

    const now = this.now();
    return this.database.transaction(context, async (runner): Promise<InboundStatus> => {
      const locked = await this.hooks.findById(runner, context, hook.id, true);
      if (!locked) return 401;
      if (await this.hooks.deliverySeen(runner, context, hook.id, deliveryId)) return 202;
      const fresh =
        locked.eventsHourStartedAt === null ||
        now.getTime() - locked.eventsHourStartedAt.getTime() >= HOUR_MS;
      const count = fresh ? 0 : locked.eventsHourCount;
      if (count >= GITHUB_EVENTS_PER_HOUR) return 429;
      await this.hooks.recordDelivery(
        runner,
        context,
        hook.id,
        deliveryId,
        now,
        new Date(now.getTime() - GITHUB_DELIVERY_RETENTION_MS),
      );
      await this.hooks.recordEvent(
        runner,
        context,
        hook.id,
        { hourStartedAt: fresh ? now : (locked.eventsHourStartedAt ?? now), count: count + 1 },
        now,
      );
      if (locked.status === 'active') {
        await this.apply(runner, context, locked, input.event ?? '', payload, now);
      }
      return 202;
    });
  }

  /** Link or unlink by key. Unknown keys, other repositories and other events change nothing. */
  private async apply(
    runner: TenantQueryRunner,
    context: TenantContext,
    hook: GithubRepoHookRow,
    event: string,
    payload: Record<string, unknown>,
    at: Date,
  ): Promise<void> {
    const repository = record(payload['repository']);
    const repoFullName = str(repository['full_name'])?.toLowerCase();
    if (repoFullName !== hook.repoFullName) return;
    const repoUrl = httpsUrl(repository['html_url']);

    if (event === 'delete') {
      const ref = str(payload['ref']);
      if (payload['ref_type'] === 'branch' && ref !== null) {
        await this.keys.removeBranchLinks(runner, context, hook.repoFullName, ref);
      }
      return;
    }

    const candidates = githubLinkCandidates(event, payload, repoUrl);
    if (candidates.length === 0) return;
    const prefixes = await this.keys.activePrefixes(
      runner,
      context,
      parseProjectIds(hook.projectIdsJson),
    );
    if (prefixes.size === 0) return;
    const prefixSet = new Set(prefixes.values());

    const wanted: { key: string; link: LinkCandidate['link'] }[] = [];
    const distinct = new Set<string>();
    for (const candidate of candidates) {
      for (const key of parseWorkKeys(candidate.text, prefixSet)) {
        const formatted = formatWorkKey(key.prefix, key.number);
        if (!distinct.has(formatted) && distinct.size >= MAX_KEYS_PER_EVENT) continue;
        distinct.add(formatted);
        if (wanted.length < MAX_LINKS_PER_EVENT)
          wanted.push({ key: formatted, link: candidate.link });
      }
    }
    const items = await this.keys.resolveKeys(runner, context, [...distinct], [...prefixes.keys()]);
    for (const { key, link } of wanted) {
      const workItemId = items.get(key);
      if (workItemId === undefined) continue;
      await this.keys.upsertLink(
        runner,
        context,
        { ...link, workItemId, connectionId: hook.connectionId, repoFullName: hook.repoFullName },
        at,
      );
    }
  }

  private webhookUrl(id: string): string {
    return `${this.publicBaseUrl}/v1/public/integrations/github/${id}`;
  }

  private encrypt(secret: string, id: string): string {
    return this.cipher.encrypt(secret, { purpose: 'integration_token', ownerId: id });
  }

  private requireCipher(): void {
    if (!this.cipher.enabled) {
      throw new ApiError(
        409,
        'conflict',
        'GitHub webhooks need encryption keys on this server',
        undefined,
        'github_hooks_unavailable',
      );
    }
  }

  private unknownProject(): ApiError {
    return new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'projectIds', message: 'must name readable, active projects of this organization' },
    ]);
  }

  private notFound(): ApiError {
    return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'github_hook_not_found');
  }
}

/** The texts to scan for keys in one event, each with the link a match produces. */
export function githubLinkCandidates(
  event: string,
  payload: Record<string, unknown>,
  repoUrl: string | null,
): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  const branchLink = (branch: string, actor: string | null): LinkCandidate | null =>
    repoUrl === null
      ? null
      : {
          text: branch,
          link: {
            linkKind: 'branch' satisfies CodeLinkKind,
            externalId: branch.slice(0, 190),
            title: branch.slice(0, MAX_TITLE),
            state: null,
            url: `${repoUrl}/tree/${encodeURI(branch)}`,
            actorLogin: actor,
          },
        };
  const sender = str(record(payload['sender'])['login']);

  if (event === 'push') {
    if (payload['deleted'] === true) return out;
    const ref = str(payload['ref']) ?? '';
    if (ref.startsWith('refs/heads/')) {
      const branch = branchLink(ref.slice('refs/heads/'.length), sender);
      if (branch) out.push(branch);
    }
    const commits = Array.isArray(payload['commits']) ? payload['commits'].slice(0, 20) : [];
    for (const raw of commits) {
      const commit = record(raw);
      const sha = str(commit['id']);
      const url = httpsUrl(commit['url']);
      const message = str(commit['message']);
      if (sha === null || url === null || message === null) continue;
      out.push({
        text: message,
        link: {
          linkKind: 'commit',
          externalId: sha.slice(0, 190),
          title: firstLine(message),
          state: null,
          url,
          actorLogin: str(record(commit['author'])['username']) ?? sender,
        },
      });
    }
    return out;
  }
  if (event === 'pull_request') {
    const pr = record(payload['pull_request']);
    const number = pr['number'];
    const url = httpsUrl(pr['html_url']);
    const title = str(pr['title']) ?? '';
    if (typeof number !== 'number' || url === null) return out;
    const state = pr['merged'] === true ? 'merged' : pr['state'] === 'closed' ? 'closed' : 'open';
    out.push({
      text: `${title} ${str(record(pr['head'])['ref']) ?? ''}`,
      link: {
        linkKind: 'pr',
        externalId: String(number),
        title: title.slice(0, MAX_TITLE),
        state,
        url,
        actorLogin: str(record(pr['user'])['login']) ?? sender,
      },
    });
    return out;
  }
  if (event === 'create' && payload['ref_type'] === 'branch') {
    const branch = branchLink(str(payload['ref']) ?? '', sender);
    if (branch && branch.text !== '') out.push(branch);
  }
  return out;
}
