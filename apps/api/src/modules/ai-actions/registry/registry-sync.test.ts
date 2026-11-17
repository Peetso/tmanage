import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Capability } from '@tmanage/domain';
import {
  AI_SCOPES,
  NEVER,
  OPS,
  RISK_CLASSES,
  classifiedRouteKeys,
  neverByKey,
  opByRouteKey,
  routeKey,
} from './index.js';
import { IS_PUBLIC, REQUIRED_CAPABILITY, SKIPS_TENANT } from '../../../common/http/decorators.js';

// `import.meta.glob` is typed by a global `ImportMeta` augmentation that ships with docx's
// declarations (R5), so this file no longer declares its own (that was a duplicate identifier);
// the eager result is cast to its shape.
type EagerModules = Record<string, Record<string, unknown>>;

/**
 * T-REG-01 — `registry-sync.every-route-classified` (plan §6, architecture B3).
 *
 * The registry is only safe if it cannot silently fall behind the API. This test is the thing
 * that keeps it honest: it enumerates every live HTTP route from the controllers themselves and
 * fails unless each one is classified *exactly once* — as an op in the registry or as a `NEVER`
 * deny-list entry — with the op's mirrored capability matching the route's real capability.
 *
 * A new unclassified route therefore fails the build, which is the whole point of slice S1: the
 * AI surface can never quietly acquire a route nobody risk-classified.
 *
 * ## Why reflection rather than a booted Nest app
 *
 * The plan sketched `DiscoveryService` + `Reflector`, which need a running application context —
 * and this application's context needs a database (ADR-0002). This is a `unit` test, so instead
 * it reads the very same metadata those services read (`@Controller`/`@Get`/… and the custom
 * route symbols) straight off the controller classes, with no container and no database. The
 * route set this produces is identical to the router's, because it is the router's own input.
 */

/** Nest's own metadata keys (`@nestjs/common/constants`): the route path and HTTP verb index. */
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
/** `RequestMethod` enum order. Only the first five occur across the 710 routes. */
const METHOD_NAMES = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/** The number of live routes at the time slice S1 classified them (plan §2). A canary: when the
 *  API genuinely gains or loses a route this is updated in the same change that classifies it.
 *  710 at S1; +6 at S7 (the OAuth AS: three discovery metadata GETs and /oauth authorize, token,
 *  revoke); +1 at S8 (POST /oauth/register, DCR); +2 at S13 (GET /openapi/ai.json and
 *  GET /downloads/tmanage-mcp.tgz, the connector's discovery/distribution surface), all withheld
 *  via NEVER. S9: +3 (GET /v1/oauth/consent, POST /v1/oauth/consent/deny and
 *  POST /v1/organizations/:orgSlug/oauth/consent, the consent page's API), also NEVER.
 *  S10: +3 (GET, approve and decline under /v1/organizations/:orgSlug/ai/approvals/:id, the
 *  approve page's API), also NEVER. 0210 (Google Drive storage): +11 — 4 ops (storage state,
 *  attachments list/create/delete) and 7 NEVER (`storage_connection`). S11: +4 (the Connected
 *  apps list, revoke and workspace AI switch under /v1/organizations/:orgSlug/oauth, and
 *  PUT /v1/platform/settings/ai-access), all NEVER. 0211 (deliverables, audit gap 1): +6 ops
 *  under /v1/organizations/:orgSlug/deliverables (list, create, get, versions, approvers, send).
 *  0212 (request messages, audit gap 4): +4 ops, GET/POST .../client-requests/:id/messages and
 *  GET/POST .../portal/requests/:id/messages. BK3 (0214): +5 ops, GET .../mention-candidates
 *  and GET/POST .../direct-conversations(/:id/messages). BK5 (0213): +2 ops, PATCH .../meetings/:meetingId
 *  and DELETE .../meetings/:meetingId/attendees/:attendeeId.
 *  Q4: +1 op, POST .../members/:membershipId/password-reset (org-admin reset link, confirm).
 *  t2-b: +2 ops, GET/PUT .../me/profile (the member's own name and job title).
 *  BK3-left (0216): +1 op, PUT .../direct-conversations/:id/read-state (DM mark-read).
 *  BK5 (0217): +4 ops, GET .../meetings/:meetingId/attendees/client-candidates and
 *  GET/GET/PUT .../portal/meetings(/:meetingId(/rsvp)) (client people as attendees).
 *  A14 (0226): +1 op, DELETE .../automations/templates/:id (soft-delete a rule, confirm).
 *  A10 (0223): +1 op, GET .../projects/:projectId/updates (internal updates list, drafts included).
 *  A7 (0220): +1 op, POST .../client-requests/:clientRequestId/reopen ("Reopen now").
 *  A11 (0224): +4 ops, GET .../profile, PATCH /v1/organizations/:orgSlug, PUT/DELETE .../logo.
 *  A9 (0222): +2 ops, GET .../projects/:projectId/milestone-plan and DELETE .../milestones/:id.
 *  B4: +1 op, PATCH .../documents/:documentId (rename, optimistic on updatedAt).
 *  B3: +2 ops, GET/PATCH .../file-download-policy (downloads before a virus scan, owner-only write).
 *  C5: +1 op, GET .../conversations/:conversationId/reactions (batched reaction tallies). */
// C6: +4 ops, GET .../logo, GET/PUT/DELETE .../logo/image (company logo, organization-scoped).
// L2: +1 op, GET .../conversations/:conversationId/attachments (batched message attachments).
// wave11 Q1: +1 NEVER google-drive project files list (was 804 after wave9 S8/S7).
// 0236 OneDrive: +12 (4 ops, 8 NEVER), was 805.
// 0237 meetings + Google Calendar: +11 (6 ops, 5 NEVER), was 817.
// 0237 slice C: +1 NEVER, GET .../integrations/google-calendar/team (owners' team list), was 833.
// platform-admin v2 · PA-01: +5 NEVER (roles matrix, overrides GET/PUT, effective-permissions, me).
// platform-admin v2 verifier: +145 NEVER (every /v1/platform route of PA-02..PA-10, the banner
// read and the public announcement read), was 839.
// 55-21 product events: +3 NEVER (ease-scoreboard, events, portal/events), was 984.
// 51-12 public status summary: +1 NEVER (public/site/status/summary), was 987.
// 51-11 deliverability: +3 NEVER (public/email/unsubscribe GET+POST, platform/email-deliverability), was 988.
// 56-02 keys +2, 54-17 data-location +1 NEVER; was 991.
// 56-32 host capacity: +1 NEVER (GET /v1/platform/health/capacity), was 994.
// 52-21 abuse engine: +4 NEVER (GET public/form-proof, GET/POST/DELETE admin/block-rules), was 995.
// 56-31 mail lanes: +2 NEVER (GET /v1/platform/mail/health, POST .../mail/lanes/:lane/pause), was 999.
// 56-07 public links: +6 NEVER (3 public/links/:token, GET/POST/DELETE .../public-links), was 1001.
// 52-20 public forms: +7 NEVER (2 public/forms/:slug, publish, unpublish, submissions list, spam,
// convert), was 1007.
// 52-08 quotes: +5 NEVER (list, create, get, update draft, send), was 1014.
// 56-17 security reports: +4 NEVER (POST public/security-reports, GET/GET :id/PUT :id platform), was 1019.
// 56-11 audit chain: +3 NEVER (GET .../admin/audit/{integrity,catalog,export.sig}), was 1023.
// 52-23 finance: +8 NEVER (profile GET/PUT, tax-rates GET/POST/PUT :id, exchange-rates GET/POST,
// readiness), was 1026.
// 56-23 security signals: +4 NEVER (GET admin/security/events, GET/PUT platform/alerts, GET
// platform/security-signals), was 1034.
// 52-01 timer: +5 NEVER (GET time/timer, POST time/timer/{start,stop,heartbeat}, GET time/active),
// was 1038.
// R4 slices 6–11 file viewer: +27 NEVER (`file_review`: previews, review threads/comments, mention
// search, decisions; studio and portal), was 1045.
// R4 slice 13 Figma links: +17 NEVER (13 `figma_links`: connection, links, snapshots, inspect;
// 4 `file_review`: threads on frames, studio and portal), was 1072.
// R5 docs rich editor: +6 ops (comments resolve POST/DELETE, export.html, export.docx, presence
// GET/PUT), was 1089.
// R7 slice 5: +1 op, GET .../conversations/:conversationId/link-previews.
// R7 slice 3: +11 NEVER (`chat_groups`: group info/settings/members/role/leave/invite, invite
// preview/join, portal chat list).
// R7 slice 6: +5 NEVER (presence heartbeat/list, privacy preferences GET/PUT, receipts).
// R7 slice 4: +1 op, POST .../messages/:messageId/forward, was 1112.
// R7 slice 2: +5 NEVER (`session`: chat list, pin/unpin, archive/unarchive), was 1113.
// R12 slice 1: +1 NEVER (`public_site`: GET /v1/public/locale-hint), was 1118.
// R12 slice 2: +3 NEVER (session / admin / platform sign-in trail CSVs), was 1119.
// R13 slice 5 (57-14): +2 NEVER (GET platform/activity/growth, .../growth/export.csv), was 1122.
// R13 slice 6 (56-21b): +2 NEVER (GET platform/team/access-review, POST .../record), was 1124.
// R13 slice 2 (webhooks v2): +6 NEVER (rotate-secret, pause, resume, replay, delivery retry, GET
// public/webhook-events), was 1126.
// R13 slice 3 (56-09): +2 NEVER (GET/DELETE security/tokens), was 1132.
// R13 slice 4 (53-02): +8 NEVER (org and project working-calendar, holidays, import-pack), was 1134.
// R15-b (52-03): +4 NEVER (time period locks list/create/delete/unlock-request), was 1142.
// R15-a (52-04): +11 NEVER (`finance_settings`: rate cards, entries, resolve, reprice, cost
// rates), was 1146.
// R15-c (54-05 / 54-06 Phase 0): +5 NEVER (`automation_secrets`: channel links create, list,
// delete, test, resume), was 1157.
// R16 (52-02/03 timesheets, 52-05 budget burn + portal budget, 52-07 expenses, 53-04 dependency
// PATCH + cascade preview/apply, 54-10 GitHub repo hooks, work-key prefix, code links, 54-11
// contact suggestions): +34, was 1162.
// R17 (52-14 finance reports, 53-06 critical path, 53-05 baselines, 52-06 retainers, 53-09
// recurrence v2): +25, was 1196.
// R18 (52-23 client invoices +15, 55-07 suggest-due +1, 55-25 quick-add +1, sign-in policy +2,
// platform incidents +6): +25, was 1221.
// R19 (tax document labels +3, finance exports +2, milestone timeline +4, iterations +8, file
// safety +2): +19, was 1246.
// R20 (link unfurl +1, person load +1, allocation confirm +1): +3, was 1265.
// R21 (org workload +1, allocation edit/delete +2, einvoice +1, inbound e-mail +6): +10, was 1268.
// R22 (einvoice certificate +3, chain status +1, inbound webhook +1, attachment preview/download/
// ask-resend +3, Jira REST source +1): +9, was 1278.
// R23 (import undo +1): +1, was 1287.
// R27 (A21 inbox mark done +1): +1, was 1288.
// R28 (B10 client company projects +1): +1, was 1289.
// R28 (B13 audit event changes +1): +1, was 1290.
// R31 (A17 workspace incidents +1): +1, was 1292.
// R31 (A13 people overview capacity/time-off/allocations +3 ops, A14 workload-hours read + capacity
// PUT +2 ops): +5, was 1293.
// R32 (C25 GET work-items/:id/client-audience +1 op): +1, was 1298.
// R33 (C26 GET people + PUT people/doers + PUT people/supervisors + POST people/watchers, +4
// ops): +4, was 1299.
// C27 (DELETE people/watchers/:userId, +1 op): +1, was 1303.
// R35 52-18 (GET + POST deliverables/:id/versions/:versionId/external-approvals, +2 NEVER): +2,
// was 1305.
// R37 (GET platform/connect-setup, +1 NEVER) and R35 53-15 (GET + PUT me/notification-matrix,
// +2 ops): +3, was 1307.
// R39 55-17 (support threads: 5 org + 4 platform routes, +9 NEVER): +9, was 1310.
// R40 L2 53-13 (AI meeting note drafts: list + submit ops, review NEVER): +3, was 1319.
// R40 L1 54-22 (GET + POST projects/templates/packs, +2 ops, classified by L2): +2, was 1322.
// R41 L2 54-01 (connector framework: list, status, install, uninstall, +4 NEVER): +4, was 1324.
// R41 L1 54-14 (company sign-in: 3 owner settings + 3 public sign-in routes, +6 NEVER): +6, was 1328.
// R42 L1 56-22 (passkeys: 2 public sign-in + 6 own-account routes) and L3 54-15 (SAML ACS +
// metadata), +10 NEVER: +10, was 1334.
// R43 L1 55-14 (client portal magic-link sign-in: 5 public routes, +5 NEVER): +5, was 1344.
// R44 L2 56-23 mark reviewed + 56-06 blocked files (list, delete now), +3 NEVER: +3, was 1349.
// R44 L1 52-08 (POST quotes/:quoteId/convert, client money, +1 NEVER): +1, was 1352.
// R45 L1 53-11 (GET work-items/:workItemId/comments/mention-candidates, work.read): +1, was 1353.
// R45 L3 54-25 (Trello / Asana token import: 5 POST/DELETE + 1 GET, +6 NEVER): +6, was 1354.
// R46 L1 (53-09 POST recurrence/preview draft and 54-11 POST contacts/import-preview, +2 NEVER):
// +2, was 1360.
// R46 L2 (54-05/54-06/56-21 channel notices + platform governance, +9 NEVER) and R46 L3 (53-10
// document collab join/steps/snapshot/cursor, +5 NEVER `session`): +13, was 1362.
// R49 L1 55-11/55-22 (getting-started: GET, steps/:step/complete, dismiss, setup-health):
// +4, was 1380.
// R49 L3 54-16 (SCIM 2.0: 15 /v1/scim/v2 routes + 3 security/scim key routes, +18 NEVER):
// +18, was 1384.
// FIX3 (live check a6f66e47): remove a cancelled meeting (DELETE meetings/:meetingId): +1.
// FIX3 items 6 and 11: archive / unarchive / delete a doc, and the Files hub's project list: +4.
// FIX5 item 5 (B-N5): delete a file and restore it (DELETE files/:fileId, POST .../restore): +2.
// FIX5 one-click connectors: app-connect status/start/complete/disconnect/channels (6) and the
// GitHub, Slack and Teams callbacks (3): +9.
// FIX5 Slack/Teams removed: app-connect channels (2), the Slack and Teams callbacks (2) and the
// R15-c pasted channel-link routes (5) are no longer registered: -9.
// FIX 2026-11-10 automatic time tracking: GET time/auto, PUT settings, PUT current-task, POST
// heartbeat, PATCH policy, GET time/team, GET time/team/:membershipId/day (+7 NEVER).
// FIGMA lane (2026-11-14): PUT figma/links/:linkId/pages, GET figma/frames/:frameId/render and
// /thumb, GET portal/figma/links, GET portal/figma/frames/:frameId/render and /thumb (+6 NEVER).
// TIMER lane (2026-11-14): PUT time/auto/device, PATCH time/rounding (+2 NEVER), POST
// time/timesheets/:timesheetId/entries/split and /delete (+2 ops).
// UX test 2026-11-15: POST time/timer/discard (+1 NEVER).
// UX-1 2026-11-15: POST deliverables/:id/versions/:versionId/share (classified).
// FIX6 item 8: POST deliverables/:id/delete and /restore (classified).
// FIX6 C1: POST work-items/:id/drive-files and /onedrive-files, deliverables/:id/drive-files and
// /onedrive-files (+4 classified).
// FIX6 C3: work-items/:id/cloud-folders (list, attach, remove, children, content) and the portal's
// list, children and content (+8 classified).
// 53-14: calendar-sync due-date mirror and feed (GET/POST/DELETE), the two push webhooks and the
// ICS feed (+7 NEVER).
// 52-19: the approval record, staff and portal (+2 classified).
// 52-27: the portal journey stepper read (+1 classified).
// 58-C1: the branching builder's flow read, save and turn-on (+3 classified).
// 57-02: the workspace's current plan (+1 classified) and the platform plan versions (+2 NEVER).
// 57-10: the published support targets (+1 NEVER, public site).
// 53-12: meeting call, join, attendance and quick rooms; portal call and join (+9 classified).
// 52-26: e-sign requests (create, list, get, cancel, remind) and the portal list/read (+7
// classified); the portal's code and signature (+2 NEVER).
// 52-19 / 52-26 PDF: the approval certificate and signed document PDFs, staff and portal (+4 NEVER).
// 51-05: "Continue with Microsoft" availability, start, callback and second step (+4 NEVER).
// PORTALA11Y: the portal's own accessibility read and save (+2 classified).
// 51-17: storage hand-over targets and request (+2 NEVER, storage_connection).
// 56-07p: the public link manager's list, bulk revoke and new end date (+3 NEVER).
// 51-17 slice 2: Google Drive and OneDrive company root options (+2 NEVER, storage_connection).
// 52-13: the client portal invoice print document (+1 NEVER).
// MFAOPTIONS: sign-in e-mail code, turn e-mail on and confirm, choose the default (+4 NEVER).
// 52-10: invoice and quote PDFs, team and portal (+4 NEVER).
// 52-27: client journey steps (list, add, from template, edit, remove), journey templates, and the
// portal form step read and send (+8 classified).
// 57-13b: "Move to Drive" start, latest and one job (+3 NEVER, storage_connection).
// 52-20a: public form attachments — upload-token, uploads open/complete/cancel and the owner's
// attachments switch (+5 NEVER, public_intake).
// 56-26: bounce intake + bounce status / clear (+3 NEVER: public_intake, org_security_manage).
const EXPECTED_ROUTE_COUNT = 1527;
// D4: +2 ops, GET .../billing/plan-usage(/preview). D5: +10 (admin/privacy, me/privacy).
// C1: +1 op, DELETE .../automations/templates/:templateId/conditions/:conditionId.
// C7: +2 ops, GET/POST .../files/:fileId/versions (version history for plain attachments).

interface LiveRoute {
  readonly method: string;
  readonly path: string;
  readonly capability: Capability | null;
  readonly isPublic: boolean;
  readonly skipsTenant: boolean;
  readonly source: string;
}

/** Build the full route path exactly as the extractor that generated the registry did. */
function joinPath(basePath: string, subPath: string): string {
  return `/${[basePath, subPath].filter((s) => s !== undefined && s !== '').join('/')}`.replace(
    /\/+/g,
    '/',
  );
}

function enumerateLiveRoutes(): LiveRoute[] {
  // Eagerly import every controller. Importing only defines the classes (no providers are
  // instantiated and nothing connects to a database), so reading their metadata is cheap.
  // `import.meta.glob` is a Vite transform: it must be referenced by that exact literal name
  // (Vite replaces it statically), so the call stays verbatim; only its result is cast.
  const modules = import.meta.glob('../../**/*.controller.ts', { eager: true }) as EagerModules;
  const routes: LiveRoute[] = [];
  for (const [modulePath, mod] of Object.entries(modules)) {
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const ctor = exported as new (...args: unknown[]) => unknown;
      const basePath = Reflect.getMetadata(PATH_METADATA, ctor);
      if (basePath === undefined) continue; // not a controller
      const classPublic = Reflect.getMetadata(IS_PUBLIC, ctor) === true;
      const classSkipsTenant = Reflect.getMetadata(SKIPS_TENANT, ctor) === true;
      const proto = ctor.prototype as object;
      for (const handlerName of Object.getOwnPropertyNames(proto)) {
        if (handlerName === 'constructor') continue;
        const handler = (proto as Record<string, unknown>)[handlerName];
        if (typeof handler !== 'function') continue;
        if (!Reflect.hasMetadata(PATH_METADATA, handler)) continue;
        const subPath = Reflect.getMetadata(PATH_METADATA, handler) as string;
        const methodIdx = Reflect.getMetadata(METHOD_METADATA, handler) as number;
        const method = METHOD_NAMES[methodIdx] ?? `IDX_${methodIdx}`;
        const capability =
          (Reflect.getMetadata(REQUIRED_CAPABILITY, handler) as Capability | undefined) ??
          (Reflect.getMetadata(REQUIRED_CAPABILITY, ctor) as Capability | undefined) ??
          null;
        routes.push({
          method,
          path: joinPath(basePath as string, subPath),
          capability,
          isPublic: Reflect.getMetadata(IS_PUBLIC, handler) === true || classPublic,
          skipsTenant: Reflect.getMetadata(SKIPS_TENANT, handler) === true || classSkipsTenant,
          source: `${modulePath} ${handlerName}`,
        });
      }
    }
  }
  return routes;
}

const liveRoutes = enumerateLiveRoutes();
const liveByKey = new Map(liveRoutes.map((r) => [routeKey(r.method, r.path), r] as const));

describe('AI action registry sync (T-REG-01)', () => {
  it('discovers the live routes at all', () => {
    expect(liveRoutes.length).toBeGreaterThan(0);
  });

  it('classifies every live route exactly once (op XOR never)', () => {
    const unclassified: string[] = [];
    const doubleClassified: string[] = [];
    for (const [key, route] of liveByKey) {
      const isOp = opByRouteKey.has(key);
      const isNeverKey = neverByKey.has(key);
      if (!isOp && !isNeverKey) unclassified.push(`${key}  (${route.source})`);
      if (isOp && isNeverKey) doubleClassified.push(key);
    }
    expect(unclassified, `unclassified live routes:\n${unclassified.join('\n')}`).toEqual([]);
    expect(
      doubleClassified,
      `routes in both OPS and NEVER:\n${doubleClassified.join('\n')}`,
    ).toEqual([]);
  });

  it('has no op or never entry pointing at a route that no longer exists', () => {
    const stale: string[] = [];
    for (const key of classifiedRouteKeys()) if (!liveByKey.has(key)) stale.push(key);
    expect(stale, `classified routes with no matching live route:\n${stale.join('\n')}`).toEqual(
      [],
    );
  });

  it("mirrors each op's capability from the live route (drift detector)", () => {
    const mismatches: string[] = [];
    for (const op of OPS) {
      const live = liveByKey.get(routeKey(op.method, op.path));
      if (!live) continue; // covered by the stale-entry test
      if ((op.capability ?? null) !== (live.capability ?? null))
        mismatches.push(`${op.id}: op=${op.capability} live=${live.capability}`);
    }
    expect(mismatches, `capability drift:\n${mismatches.join('\n')}`).toEqual([]);
  });

  it('never exposes a public or tenant-less route as an op (architecture B3)', () => {
    const leaked: string[] = [];
    for (const op of OPS) {
      const live = liveByKey.get(routeKey(op.method, op.path));
      if (live && (live.isPublic || live.skipsTenant)) leaked.push(op.id);
    }
    expect(leaked, `ops referencing ungated routes:\n${leaked.join('\n')}`).toEqual([]);
  });

  it('withholds every public and tenant-less route via NEVER', () => {
    const exposedByOmission: string[] = [];
    for (const route of liveRoutes) {
      if (!route.isPublic && !route.skipsTenant) continue;
      if (!neverByKey.has(routeKey(route.method, route.path)))
        exposedByOmission.push(`${route.method} ${route.path}`);
    }
    expect(
      exposedByOmission,
      `ungated routes missing from NEVER:\n${exposedByOmission.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps op ids unique and fields well-formed', () => {
    const ids = OPS.map((op) => op.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const op of OPS) {
      expect(RISK_CLASSES, op.id).toContain(op.risk);
      expect(AI_SCOPES, op.id).toContain(op.scope);
      expect(op.id, op.path).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    }
  });

  it('accounts for the full known route surface (canary)', () => {
    expect(
      liveRoutes.length,
      `live route count changed from ${EXPECTED_ROUTE_COUNT} to ${liveRoutes.length}; ` +
        'classify the added/removed routes and update EXPECTED_ROUTE_COUNT in the same change.',
    ).toBe(EXPECTED_ROUTE_COUNT);
    expect(OPS.length + NEVER.length).toBe(liveRoutes.length);
  });
});
