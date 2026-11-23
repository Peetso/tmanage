import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from '@tmanage/domain';
import type { CatalogTool } from '@tmanage/mcp-server';
import { OPS, sensitivityOf } from '../ai-actions/registry/index.js';
import type { AiActionOp } from '../ai-actions/registry/index.js';
import { BOUND_TOKEN_NO_TENANT_ALLOWLIST } from '../../common/http/guards/bound-token-allowlist.js';
import { changeGateFor } from '../copilot/ai-preview.js';
import { CHAT_FULL_SCOPES } from '../copilot/copilot-chat.service.js';
import { liveMcpSurface } from './catalog-runtime.js';
import {
  PendingActionRefusedError,
  buildApprovalSummary,
  buildOpRequest,
  freezeConfirmAction,
  isUnsafePathSegment,
} from './pending-actions.js';
import { allDetailsById } from './tool-catalog.js';

/**
 * AI tamper review, 2026-11-23. The owner asked that nobody can bend what the AI runs: another
 * person's password or sign-in, another workspace, or the data that reaches the server. Each block
 * here fails when the protection it names is removed. The report is
 * `work/pass-2026-11-23/AI-TAMPER-SECURITY-REPORT.md` (OWASP LLM01/LLM06 2025, ASVS 5.0).
 */

const ORG_PREFIX = '/v1/organizations/:orgSlug/';
// Platform-admin ops (`/v1/platform/*`) have no workspace; this file checks the workspace ones.
const isPlatformOp = (op: AiActionOp): boolean => op.path.startsWith('/v1/platform');
const tenantOps = OPS.filter((op) => !isPlatformOp(op));
const paramsOf = (op: AiActionOp): string[] =>
  [...op.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!).filter((p) => p !== 'orgSlug');
const firstExample = (op: AiActionOp): Record<string, unknown> | undefined => {
  const detail = allDetailsById.get(op.id);
  const args = detail?.examples[0]?.args as Record<string, unknown> | undefined;
  return args !== undefined && detail!.input.safeParse(args).success ? args : undefined;
};

const OWNER = new Set<string>(capabilitiesFor('owner'));

function surface(profile: 'compact' | 'full' = 'compact') {
  const fetched: { url: string; body: string | undefined }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    fetched.push({
      url: String(url),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const { runtime, catalog } = liveMcpSurface({
    profile,
    scopes: CHAT_FULL_SCOPES,
    capabilities: OWNER,
    orgSlug: 'northstar',
    baseUrl: 'http://in-process',
    fetch: fetchImpl,
    storedField: async () => 'internal',
  });
  const tool = (name: string): CatalogTool => catalog.tools.find((t) => t.name === name)!;
  return { runtime, tool, fetched };
}

describe('threat 1 — the AI cannot act on another person’s account', () => {
  it('every workspace op lives under the token’s own workspace (no account-level route is an op)', () => {
    const outside = tenantOps.filter(
      (op) => !op.path.startsWith(ORG_PREFIX) && op.path !== '/v1/organizations/:orgSlug',
    );
    expect(outside.map((op) => `${op.method} ${op.path}`)).toEqual([]);
  });

  it('no op takes a password, a one-time code, a recovery code or a secret as an argument', () => {
    const credential =
      /^(password|newPassword|currentPassword|passcode|otp|totp|code2fa|recoveryCode|secret|clientSecret|privateKey)$/i;
    const offending = OPS.flatMap((op) => {
      const shape = (allDetailsById.get(op.id)?.input as { shape?: Record<string, unknown> })
        ?.shape;
      return Object.keys(shape ?? {})
        .filter((key) => credential.test(key))
        .map((key) => `${op.id}.${key}`);
    });
    expect(offending).toEqual([]);
  });

  it('the only workspace ops that touch another member’s sign-in are admin acts, always confirm-class', () => {
    const signIn =
      /(password|two-step|2fa|totp|mfa|passkey|webauthn|recovery|(?<!upload-)sessions|tokens|sign-in-methods|identities)/i;
    const touching = tenantOps.filter((op) => op.method !== 'GET' && signIn.test(op.path));
    // The reset email goes to the member's own stored address; the revoke ends one session in this
    // workspace. Both are the owner/admin's manual powers, frozen for the member's own approval.
    expect(touching.map((op) => op.id).sort()).toEqual([
      'admin.sessions.revoke.create',
      'members.password_reset.create',
    ]);
    for (const op of touching) expect(op.risk).toBe('confirm');
  });

  it('no account route (password, two-step, sessions, tokens, e-mail) is open to an AI token', () => {
    const account =
      /(password|two-step|2fa|mfa|passkey|session|token|email|recovery|\/me\b|identit)/i;
    expect([...BOUND_TOKEN_NO_TENANT_ALLOWLIST].filter((key) => account.test(key))).toEqual([]);
  });
});

describe('threat 2 — the workspace is the grant’s, never the model’s', () => {
  it('no workspace op accepts orgSlug, organizationId or tenantId as an argument', () => {
    const tenantKey = /^(orgSlug|organizationId|organisationId|tenantId|orgId)$/;
    const offending = tenantOps.flatMap((op) => {
      const shape = (allDetailsById.get(op.id)?.input as { shape?: Record<string, unknown> })
        ?.shape;
      return Object.keys(shape ?? {})
        .filter((key) => tenantKey.test(key))
        .map((key) => `${op.id}.${key}`);
    });
    expect(offending).toEqual([]);
  });

  it('an orgSlug smuggled into the arguments is ignored: the URL carries the grant’s workspace', () => {
    for (const op of tenantOps) {
      const args = Object.fromEntries(paramsOf(op).map((p) => [p, 'x1']));
      const built = buildOpRequest(op, { ...args, orgSlug: 'victim-co' }, 'northstar');
      expect(built.url).toMatch(/^\/v1\/organizations\/northstar(\/|\?|$)/);
      expect(built.url).not.toContain('victim-co');
      expect(built.body ?? '').not.toContain('victim-co');
    }
  });

  it('a run with another workspace in its arguments is refused and nothing is sent', async () => {
    const { runtime, tool, fetched } = surface();
    for (const extra of [{ orgSlug: 'victim-co' }, { organizationId: 'org_victim' }]) {
      const result = await runtime.runTool(tool('tmanage_run_action'), {
        action_id: 'projects.create',
        args: { name: 'X', ...extra },
      });
      expect(result.isError).toBe(true);
    }
    expect(fetched).toEqual([]);
  });
});

describe('threat 3 — what runs is what the card or approve page shows', () => {
  it('dot segments and empty values are unsafe path arguments', () => {
    expect(['', '.', '..'].every(isUnsafePathSegment)).toBe(true);
    expect(['x1', '...', '.x', 'a.b', '%2e%2e'].some(isUnsafePathSegment)).toBe(false);
  });

  it('no op can be sent to another route through a dot-segment path argument (sweep)', () => {
    let checked = 0;
    for (const op of OPS) {
      for (const param of paramsOf(op)) {
        for (const bad of ['..', '.', '']) {
          const args = Object.fromEntries(paramsOf(op).map((p) => [p, p === param ? bad : 'x1']));
          expect(() => buildOpRequest(op, args, 'northstar')).toThrow(PendingActionRefusedError);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('a confirm-class action with a dot-segment argument is never frozen for approval', () => {
    let checked = 0;
    for (const op of OPS.filter((o) => o.risk === 'confirm')) {
      const example = firstExample(op);
      const param = paramsOf(op).find((p) => typeof example?.[p] === 'string');
      if (example === undefined || param === undefined) continue;
      expect(() => freezeConfirmAction(op.id, example)).not.toThrow();
      expect(() => freezeConfirmAction(op.id, { ...example, [param]: '..' })).toThrow(
        PendingActionRefusedError,
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('the runtime refuses `..` (documents.revisions.restore would reach documents.restore)', async () => {
    const { runtime, tool, fetched } = surface();
    const result = await runtime.runTool(tool('tmanage_run_action'), {
      action_id: 'documents.revisions.restore',
      args: { documentId: 'doc_1', revId: '..' },
    });
    expect(result.isError).toBe(true);
    expect(fetched).toEqual([]);
    const ok = await runtime.runTool(tool('tmanage_run_action'), {
      action_id: 'documents.revisions.restore',
      args: { documentId: 'doc_1', revId: 'rev_1' },
    });
    expect(ok.isError).toBeUndefined();
    expect(fetched.map((f) => f.url)).toEqual([
      'http://in-process/v1/organizations/northstar/documents/doc_1/revisions/rev_1/restore',
    ]);
  });

  it('the approve page lists every argument that runs, the 13th and later included', () => {
    const op = OPS.find((o) => o.id === 'finance.profile.set')!;
    const detail = allDetailsById.get(op.id)!;
    const args = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`field${String(i).padStart(2, '0')}`, `v${i}`]),
    );
    const summary = buildApprovalSummary(op, detail, args);
    expect(summary.fields).toHaveLength(20);
    expect(summary.fields.at(-1)).toEqual({ name: 'field19', value: 'v19' });
  });
});

describe('threat 4 — no change runs without the member’s look (prompt injection)', () => {
  it('no op that changes data (POST, PUT, PATCH, DELETE) is classed read', () => {
    expect(
      OPS.filter((op) => op.method !== 'GET' && op.risk === 'read').map((op) => op.id),
    ).toEqual([]);
  });

  it('every client-facing, destructive, money, HR, manage, billing or DELETE change asks on a card, even with run at once', () => {
    const atOnce = { runAtOnce: true, hasUndo: true };
    const leaks = OPS.filter((op) => op.risk !== 'read')
      .filter(
        (op) =>
          op.method === 'DELETE' ||
          op.scope !== 'write' ||
          op.risk === 'confirm' ||
          ['external', 'destructive', 'money', 'hr'].includes(sensitivityOf(op)),
      )
      .filter((op) => changeGateFor(op, atOnce)?.card !== true)
      .map((op) => op.id);
    expect(leaks).toEqual([]);
  });
});

describe('threat 5 — every argument is checked by the op’s own strict schema', () => {
  it('every op with an example refuses an extra organizationId, role or ownerId (mass assignment)', () => {
    let checked = 0;
    for (const op of OPS) {
      const example = firstExample(op);
      if (example === undefined) continue;
      const input = allDetailsById.get(op.id)!.input;
      for (const extra of ['organizationId', 'isOwner', 'platformRole']) {
        if (extra in example) continue;
        expect(input.safeParse({ ...example, [extra]: 'x' }).success).toBe(false);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('inbox.rules.create is strict (it was a passthrough)', () => {
    const input = allDetailsById.get('inbox.rules.create')!.input;
    const good = { matchType: 'type', matchValue: 'mention', category: 'urgent' };
    expect(input.safeParse(good).success).toBe(true);
    expect(input.safeParse({ ...good, membershipId: 'someone_else' }).success).toBe(false);
    expect(input.safeParse({ ...good, matchType: 'sql' }).success).toBe(false);
    expect(input.safeParse({}).success).toBe(false);
  });

  it('a direct op-tool call with an unknown key is refused by the runtime and nothing is sent', async () => {
    const { runtime, tool, fetched } = surface('full');
    const projectsCreate = tool('projects_create');
    expect(projectsCreate).toBeDefined();
    const result = await runtime.runTool(projectsCreate, { name: 'X', ownerRole: 'owner' });
    expect(result.isError).toBe(true);
    expect(fetched).toEqual([]);
  });
});
