import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Role } from '@tmanage/domain';
import { createSweepLockDatabase } from '@tmanage/worker';
import {
  TenantDatabase,
  createServiceContext,
  createTenantContext,
} from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { AnchorSigner } from '../src/modules/audit/audit-anchor-signer.js';
import {
  ApprovalRecordVerifyRepository,
  findRecordForVerify,
} from '../src/modules/approvals/approval-record-verify.repository.js';
import { ApprovalRecordVerifyService } from '../src/modules/approvals/approval-record-verify.service.js';
import { ApprovalRecordsRepository } from '../src/modules/approvals/approval-records.repository.js';
import { RECORD_SCHEMA } from '../src/modules/approvals/approval-records.js';
import { ApprovalEvidenceRepository } from '../src/modules/approvals/approval-records-evidence.repository.js';
import { PLAN_FEATURE_SET, PLAN_LIMITS } from '../src/modules/billing/plan-catalog.js';
import { PlanVersionsRepository } from '../src/modules/billing/plan-versions.repository.js';
import { PlanVersionsService } from '../src/modules/billing/plan-versions.service.js';
import { ReferralsRepository } from '../src/modules/billing/referrals.repository.js';
import { REFERRAL_COUNTED_PER_DAY } from '../src/modules/billing/referrals.rules.js';
import { ReferralsService } from '../src/modules/billing/referrals.service.js';
import { PlatformAdminRepository } from '../src/modules/platform-admin/platform-admin.repository.js';
import { PlatformSettingsRepository } from '../src/modules/platform-admin/settings/settings.repository.js';
import {
  PRICING_SURVEY_BOOTSTRAP_TABLES,
  PRICING_SURVEY_LIST_REASON,
  PricingSurveyRepository,
  isDuplicateAnswer,
} from '../src/modules/pricing-survey/pricing-survey.repository.js';
import { PublicFormAttachmentGate } from '../src/modules/public-forms/public-form-attachments.js';
import { PublicFormsRepository } from '../src/modules/public-forms/public-forms.repository.js';
import { StorageMoveRepository } from '../src/modules/storage-root/storage-move.repository.js';
import { OrganizationsRepository } from '../src/modules/tenancy/organizations.repository.js';
import { startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * TESTDB 2026-11-18 — the growth, plan, files and approval-record reads of the 11-17/11-18 slices
 * (migrations 0365, 0367, 0368, 0369, 0375, 0376 and the reads of 0355) on MariaDB 11.8, through
 * the real repositories and services:
 *
 * - FORMATTACH (0365): a published form with `attachment_project_id` opens a draft token and names
 *   the owner's project as the upload target; switched off, the door answers 409; a
 *   `form_attachment` asset is listed under its submission.
 * - 57-13 (0367): the job's `total_bytes` is the sum of the candidate versions' sizes.
 * - SEOD B11 (0368): a sign-up's referring host is stored and counted on the platform overview.
 * - 57-13r / 57-18 (0369): the USD v1 rows equal `PLAN_LIMITS` / `PLAN_FEATURE_SET`; the public
 *   read shows them only in paid mode.
 * - ADMINSVC: the integration count queries run and count workspaces.
 * - 52-19: the verify lookup (genuine / not found / altered) and the evidence reads.
 * - WTP (0375) and REFERRAL (0376): the engine's one-answer and one-credit keys, the tenant FKs,
 *   the self / same-domain / daily-cap outcomes and the platform totals.
 * - LOGQUIET: a sweep's named lock is held by one session at a time.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

function contextFor(
  organizationId: string,
  user: { id: string; membershipId: string },
  role: Role,
): TenantContext {
  return createTenantContext({
    organizationId,
    userId: user.id,
    membershipId: user.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor(role),
    policyVersion: 'testdb-1118',
    correlationId: uuidv7(),
  });
}

/** A ready, clean, promoted file version on TManage's own storage. */
async function cleanFile(
  organizationId: string,
  projectId: string,
  ownerUserId: string,
  sizeBytes: number,
  options: { purpose?: string; objectId?: string; clean?: boolean } = {},
): Promise<{ assetId: string; versionId: string }> {
  const assetId = uuidv7();
  const versionId = uuidv7();
  await db.admin.execute(
    `insert into file_assets
       (id, organization_id, project_id, owner_user_id, name, purpose, object_id, audience, status, version)
     values (?, ?, ?, ?, 'brief.pdf', ?, ?, 'internal', 'ready', 1)`,
    [
      assetId,
      organizationId,
      projectId,
      ownerUserId,
      options.purpose ?? 'deliverable',
      options.objectId ?? uuidv7(),
    ],
  );
  await db.admin.execute(
    `insert into file_versions
       (id, organization_id, file_asset_id, version_no, object_key, size_bytes, declared_mime_type, detected_mime_type)
     values (?, ?, ?, 1, ?, ?, 'application/pdf', 'application/pdf')`,
    [versionId, organizationId, assetId, `tenant/${organizationId}/${versionId}`, sizeBytes],
  );
  if (options.clean !== false) {
    await db.admin.execute(
      `update file_versions set trust_zone = 'private', scan_verdict = 'clean',
         scanned_at = current_timestamp(3), scanner = 'test', content_hash = ? where id = ?`,
      [createHash('sha256').update(versionId).digest('hex'), versionId],
    );
  }
  return { assetId, versionId };
}

beforeAll(async () => {
  db = await startTestDatabase();
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await db?.stop();
});

describe('FORMATTACH public-form attachments (0365)', () => {
  it('opens a draft only while the owner allows files, and targets the owner’s project', async () => {
    const org = world.northstar.organizationId;
    const formId = uuidv7();
    const slug = 'abcdefghjk';
    await db.admin.execute(
      `insert into work_forms (id, organization_id, name, fields_json, created_by, public_slug, public_enabled, published_at, attachment_project_id)
       values (?, ?, 'Brief intake', '[]', ?, ?, 1, current_timestamp(3), ?)`,
      [formId, org, world.northstar.owner.id, slug, world.northstar.projectId],
    );
    const repository = new PublicFormsRepository();
    const gate = new PublicFormAttachmentGate(
      tenant,
      repository,
      { kind: 'engine' },
      's'.repeat(48),
    );
    const draft = await gate.openDraft(slug, uuidv7());
    const { context, target } = await gate.uploadTarget(slug, draft.uploadToken, uuidv7());
    expect(context.organizationId).toBe(org);
    expect(target.projectId).toBe(world.northstar.projectId);
    expect(target.ownerUserId).toBe(world.northstar.owner.id);

    // The visitor's file is stored with the new purpose and listed under its submission.
    await cleanFile(org, world.northstar.projectId, world.northstar.owner.id, 2048, {
      purpose: 'form_attachment',
      objectId: target.submissionId,
    });
    const listed = await tenant.read(context, (runner) =>
      repository.listAttachments(runner, context, [target.submissionId]),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.submissionId).toBe(target.submissionId);

    // The owner switches attachments off: the very next upload is refused.
    const owner = contextFor(org, world.northstar.owner, 'owner');
    await tenant.transaction(owner, (runner) =>
      repository.setAttachmentProject(runner, owner, formId, null),
    );
    await expect(gate.uploadTarget(slug, draft.uploadToken, uuidv7())).rejects.toMatchObject({
      status: 409,
    });
    await expect(gate.openDraft(slug, uuidv7())).rejects.toMatchObject({ status: 409 });
  });
});

describe('57-13 storage move totals (0367)', () => {
  it('measures the candidates and stores their bytes as total_bytes', async () => {
    const org = world.brightops.organizationId;
    const owner = world.brightops.owner;
    await cleanFile(org, world.brightops.projectId, owner.id, 1_000_000);
    await cleanFile(org, world.brightops.projectId, owner.id, 2_500_000_000);
    // Not scanned yet: never a candidate.
    await cleanFile(org, world.brightops.projectId, owner.id, 7, { clean: false });
    const context = contextFor(org, owner, 'owner');
    const repository = new StorageMoveRepository();
    const figures = await tenant.read(context, (runner) =>
      repository.measureCandidates(runner, context),
    );
    expect(figures).toEqual({ files: 2, bytes: 2_501_000_000 });
    const jobId = uuidv7();
    await tenant.transaction(context, (runner) =>
      repository.insert(runner, context, {
        id: jobId,
        backend: 'google_drive',
        storageConnectionId: uuidv7(),
        requestedByUserId: owner.id,
        total: figures.files,
        totalBytes: figures.bytes,
        now: new Date('2026-11-18T08:00:00.000Z'),
      }),
    );
    const job = await tenant.read(context, (runner) => repository.findById(runner, context, jobId));
    expect(Number(job?.totalBytes)).toBe(2_501_000_000);
    expect(job?.total).toBe(2);
    // Another tenant's measure sees none of these versions.
    const twin = contextFor(world.twin.organizationId, world.twin.owner, 'owner');
    await expect(
      tenant.read(twin, (runner) => repository.measureCandidates(runner, twin)),
    ).resolves.toEqual({ files: 0, bytes: 0 });
  });
});

describe('SEOD B11 signup referrer host (0368)', () => {
  it('stores the referring host on the new organization and counts it on the overview', async () => {
    const id = uuidv7();
    const context = createServiceContext({
      organizationId: id,
      correlationId: uuidv7(),
      policyVersion: 'testdb-1118',
    });
    await tenant.transaction(context, (runner) =>
      new OrganizationsRepository().create(runner, context, {
        id,
        slug: 'orbit-design-co',
        name: 'Orbit Design Co',
        defaultLocale: 'en',
        timezone: 'UTC',
        signupAttribution: { referrer_host: 'chatgpt.com' },
      }),
    );
    const [stored] = await rows('select signup_referrer_host from organizations where id = ?', [
      id,
    ]);
    expect(stored?.['signup_referrer_host']).toBe('chatgpt.com');
    const overview = await new PlatformAdminRepository(tenant).overview(new Date(), uuidv7());
    const source = overview.signupSources.find((row) => row.referrerHost === 'chatgpt.com');
    expect(source?.signups).toBe(1);
    expect(source?.source).toBeNull();
  });
});

describe('57-13r / 57-18 plan versions (0369) and the public read', () => {
  it('the USD v1 rows carry the catalog allowance and every-plan features', async () => {
    const versions = await new PlanVersionsRepository(tenant).all(uuidv7());
    const v1 = versions.filter((v) => v.currency === 'USD' && v.version === 1);
    expect(v1.map((v) => v.planId).sort()).toEqual(Object.keys(PLAN_LIMITS).sort());
    for (const version of v1) {
      const catalog = PLAN_LIMITS[version.planId];
      expect(version.limits.storageBytes ?? null).toBe(catalog.storageBytes);
      expect(version.limits.people ?? null).toBe(catalog.people);
      expect(version.limits.maxFileBytes).toBe(catalog.maxFileBytes);
      expect([...version.features].sort()).toEqual([...PLAN_FEATURE_SET[version.planId]].sort());
      expect(version.features).toContain('security_controls');
      expect(version.features).toContain('admin_audit');
    }
  });

  it('GET /v1/public/plan-versions shows the figures only in paid mode', async () => {
    const store = new PlanVersionsRepository(tenant);
    const beta = new PlanVersionsService(tenant, store, undefined, () => new Date(), {
      BILLING_MODE: 'beta_free',
    });
    await expect(beta.publishedPlans(uuidv7())).resolves.toEqual({ visible: false, plans: [] });
    const paid = new PlanVersionsService(tenant, store, undefined, () => new Date(), {
      BILLING_MODE: 'paid',
    });
    const view = await paid.publishedPlans(uuidv7());
    expect(view.visible).toBe(true);
    const free = view.plans.find((plan) => plan.planId === 'free');
    expect(free?.limits.storageBytes).toBe(PLAN_LIMITS.free.storageBytes);
    const enterprise = view.plans.find((plan) => plan.planId === 'enterprise');
    expect(enterprise?.limits.storageBytes ?? null).toBeNull();
  });
});

describe('ADMINSVC integration counts', () => {
  it('counts workspaces per integration on the real tables', async () => {
    const repository = new PlatformSettingsRepository(tenant);
    const before = await repository.integrationCounts(uuidv7());
    expect(before.figma.connected).toBe(0);
    await db.admin.execute(
      `insert into figma_connections (id, organization_id, membership_id, token_ciphertext, token_hint, status)
       values (?, ?, ?, 'cipher', 'abcd', 'connected'), (?, ?, ?, 'cipher', 'efgh', 'revoked')`,
      [
        uuidv7(),
        world.northstar.organizationId,
        world.northstar.owner.membershipId,
        uuidv7(),
        world.twin.organizationId,
        world.twin.owner.membershipId,
      ],
    );
    const installed = new Date('2026-11-17T12:00:00.000Z');
    await db.admin.execute(
      `insert into connector_installations (id, organization_id, connector_key, installed_by, installed_at)
       values (?, ?, 'github', ?, ?), (?, ?, 'github', ?, ?), (?, ?, 'jira', ?, ?)`,
      [
        uuidv7(),
        world.northstar.organizationId,
        world.northstar.owner.id,
        installed,
        uuidv7(),
        world.twin.organizationId,
        world.twin.owner.id,
        installed,
        uuidv7(),
        world.twin.organizationId,
        world.twin.owner.id,
        installed,
      ],
    );
    const after = await repository.integrationCounts(uuidv7());
    expect(after.figma.connected).toBe(1);
    expect(after.connectors['github']?.connected).toBe(2);
    expect(after.connectors['jira']?.connected).toBe(1);
    expect(after.connectors['github']?.lastSuccessAt).not.toBeNull();
  });
});

describe('52-19 verify lookup and evidence reads', () => {
  const signer = AnchorSigner.fromEnv({});
  const records = new ApprovalRecordsRepository();

  async function appendRecord(org: string, deliverableVersionId: string) {
    const context = createServiceContext({
      organizationId: org,
      correlationId: uuidv7(),
      policyVersion: 'testdb-1118',
    });
    return tenant.transaction(context, (runner) =>
      records.append(
        runner,
        context,
        {
          schema: RECORD_SCHEMA,
          projectId: world.northstar.projectId,
          approvalId: uuidv7(),
          deliverableId: uuidv7(),
          deliverableVersionId,
          versionNo: 1,
          fileVersionId: null,
          contentHash: 'c'.repeat(64),
          approver: {
            userId: world.northstar.owner.id,
            membershipId: world.northstar.owner.membershipId,
            kind: 'internal',
            role: 'owner',
            clientOrganizationId: null,
          },
          decision: 'approved',
          comment: null,
          decidedAt: '2026-11-18T08:30:00.000Z',
          ip: null,
          userAgent: null,
        },
        signer,
      ),
    );
  }

  it('genuine for the printed id and fingerprint; not found otherwise; altered when the chain breaks', async () => {
    const org = world.northstar.organizationId;
    const first = await appendRecord(org, uuidv7());
    const second = await appendRecord(org, uuidv7());
    expect(second.recordNo).toBe(first.recordNo + 1);
    const service = new ApprovalRecordVerifyService(
      tenant,
      findRecordForVerify(tenant),
      new ApprovalRecordVerifyRepository(),
      records,
      signer,
    );
    await expect(
      service.verify({ recordId: second.id, fingerprint: second.recordHash }),
    ).resolves.toEqual({
      verdict: 'genuine',
      decidedAt: '2026-11-18T08:30:00.000Z',
      decision: 'approved',
      workspaceName: 'Northstar Studio',
    });
    // Wrong fingerprint and unknown id give the same answer, with no workspace.
    const notFound = await service.verify({ recordId: second.id, fingerprint: 'a'.repeat(64) });
    expect(notFound.verdict).toBe('not_found');
    expect(notFound.workspaceName ?? null).toBeNull();
    await expect(
      service.verify({ recordId: uuidv7(), fingerprint: second.recordHash }),
    ).resolves.toEqual(notFound);

    // A stored row whose JSON no longer hashes to what was sealed: altered, workspace only.
    const forgedJson = '{"forged":true}';
    const forgedHash = createHash('sha256').update(forgedJson).digest('hex');
    const forgedId = uuidv7();
    await db.admin.execute(
      `insert into approval_records (id, organization_id, approval_id, deliverable_version_id, record_no,
         approver_user_id, approver_kind, decision, record_json, record_hash, previous_record_hash, created_at)
       values (?, ?, ?, ?, ?, ?, 'internal', 'approved', ?, ?, ?, ?)`,
      [
        forgedId,
        org,
        uuidv7(),
        uuidv7(),
        second.recordNo + 1,
        world.northstar.owner.id,
        forgedJson,
        forgedHash,
        second.recordHash,
        new Date('2026-11-18T09:00:00.000Z'),
      ],
    );
    await expect(
      service.verify({ recordId: forgedId, fingerprint: forgedHash }),
    ).resolves.toMatchObject({
      verdict: 'altered',
      decidedAt: null,
      workspaceName: 'Northstar Studio',
    });
  });

  it('evidence: the approved file through its deliverable version, and the newest chain check, per tenant', async () => {
    const org = world.northstar.organizationId;
    const file = await cleanFile(org, world.northstar.projectId, world.northstar.owner.id, 4096);
    const deliverableVersionId = uuidv7();
    await db.admin.execute(
      `insert into deliverable_versions
         (id, organization_id, project_id, deliverable_id, version_no, content_hash, file_asset_id, file_version_id, created_by_user_id)
       values (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        deliverableVersionId,
        org,
        world.northstar.projectId,
        uuidv7(),
        'c'.repeat(64),
        file.assetId,
        file.versionId,
        world.northstar.owner.id,
      ],
    );
    await db.admin.execute(
      `insert into approval_chain_checks (id, organization_id, checked_at, status, records)
       values (?, ?, ?, 'ok', 2), (?, ?, ?, 'broken', 3), (?, ?, ?, 'ok', 9)`,
      [
        uuidv7(),
        org,
        new Date('2026-11-16T02:00:00.000Z'),
        uuidv7(),
        org,
        new Date('2026-11-17T02:00:00.000Z'),
        uuidv7(),
        world.twin.organizationId,
        new Date('2026-11-18T02:00:00.000Z'),
      ],
    );
    const evidence = new ApprovalEvidenceRepository();
    const northstar = contextFor(org, world.northstar.owner, 'owner');
    const approved = await tenant.read(northstar, (runner) =>
      evidence.approvedFile(runner, northstar, deliverableVersionId),
    );
    expect(approved).toMatchObject({
      fileVersionId: file.versionId,
      name: 'brief.pdf',
      versionNo: 1,
      trustZone: 'private',
      scanVerdict: 'clean',
    });
    expect(Number(approved?.sizeBytes)).toBe(4096);
    const latest = await tenant.read(northstar, (runner) =>
      evidence.latestChainCheck(runner, northstar),
    );
    expect(latest).toMatchObject({ status: 'broken', records: 3 });
    // The twin reads neither Northstar's file nor its checks.
    const twin = contextFor(world.twin.organizationId, world.twin.owner, 'owner');
    await expect(
      tenant.read(twin, (runner) => evidence.approvedFile(runner, twin, deliverableVersionId)),
    ).resolves.toBeNull();
    await expect(
      tenant.read(twin, (runner) => evidence.latestChainCheck(runner, twin)),
    ).resolves.toMatchObject({ status: 'ok', records: 9 });
  });
});

describe('57-17 WTP answers (0375)', () => {
  const repository = new PricingSurveyRepository();

  it('one answer per person: the engine refuses a second; the platform list names the workspace only', async () => {
    const org = world.northstar.organizationId;
    const owner = contextFor(org, world.northstar.owner, 'owner');
    const at = new Date('2026-11-18T10:00:00.000Z');
    await tenant.transaction(owner, (runner) =>
      repository.insert(runner, owner, {
        outcome: 'answered',
        band: '5_9',
        note: 'Fair for an agency',
        answeredAt: at,
      }),
    );
    await expect(
      tenant.read(owner, (runner) => repository.readState(runner, owner)),
    ).resolves.toMatchObject({ alreadyResponded: true });
    const second = tenant.transaction(owner, (runner) =>
      repository.insert(runner, owner, {
        outcome: 'skipped',
        band: null,
        note: null,
        answeredAt: at,
      }),
    );
    await expect(second).rejects.toSatisfy(isDuplicateAnswer);

    const twin = contextFor(world.twin.organizationId, world.twin.owner, 'owner');
    await tenant.transaction(twin, (runner) =>
      repository.insert(runner, twin, {
        outcome: 'skipped',
        band: null,
        note: null,
        answeredAt: at,
      }),
    );
    // The membership FK is bound within its own tenant: Northstar's member under the twin fails.
    await expect(
      db.admin.execute(
        `insert into pricing_survey_answers (id, organization_id, membership_id, outcome, answered_at)
         values (?, ?, ?, 'skipped', ?)`,
        [uuidv7(), world.twin.organizationId, world.northstar.manager.membershipId, at],
      ),
    ).rejects.toThrow(/foreign key/i);

    const listed = await tenant.bootstrapRead(
      {
        correlationId: uuidv7(),
        reason: PRICING_SURVEY_LIST_REASON,
        tables: [...PRICING_SURVEY_BOOTSTRAP_TABLES],
      },
      (runner) => repository.listAcrossOrganizations(runner),
    );
    expect(listed).toHaveLength(2);
    expect(listed.map((row) => row.organizationName).sort()).toEqual(
      [
        (await rows('select name from organizations where id = ?', [org]))[0]?.['name'],
        (
          await rows('select name from organizations where id = ?', [world.twin.organizationId])
        )[0]?.['name'],
      ].sort(),
    );
    expect(listed.find((row) => row.outcome === 'answered')).toMatchObject({
      band: '5_9',
      note: 'Fair for an agency',
    });
  });
});

describe('57-08 referrals (0376)', () => {
  it('one code per workspace; self, same-domain, counted, one credit per workspace, daily cap', async () => {
    let clock = new Date('2026-11-18T09:00:00.000Z');
    const service = new ReferralsService(
      tenant,
      new ReferralsRepository(),
      () => clock,
      () => 'beta_free',
    );
    const owner = contextFor(world.northstar.organizationId, world.northstar.owner, 'owner');
    const first = await service.ensureCode(owner);
    const again = await service.ensureCode(owner);
    expect(first.code).not.toBeNull();
    expect(again.code).toBe(first.code);
    const [codes] = await rows(
      'select count(*) as n from referral_codes where organization_id = ?',
      [world.northstar.organizationId],
    );
    expect(Number(codes?.['n'])).toBe(1);

    const signup = (email: string, name: string, organizationId = uuidv7()) =>
      service.recordSignup({
        code: first.code,
        organizationId,
        organizationName: name,
        email,
        correlationId: uuidv7(),
      });
    await expect(signup('Maya.Hassan@northstar.example', 'Maya side project')).resolves.toBe(
      'self',
    );
    await expect(signup('new.hire@northstar.example', 'Northstar Labs')).resolves.toBe(
      'same_domain',
    );
    const credited = uuidv7();
    await expect(signup('sara@orbit.example', 'Orbit Studio', credited)).resolves.toBe('counted');
    // A workspace is credited to one link only: the engine refuses a second row for it.
    await expect(signup('sara@orbit.example', 'Orbit Studio', credited)).rejects.toThrow();
    // Its own link never credits the inviting workspace itself.
    await expect(
      signup('x@elsewhere.example', 'Self', world.northstar.organizationId),
    ).resolves.toBeNull();

    for (let i = 1; i < REFERRAL_COUNTED_PER_DAY; i += 1) {
      clock = new Date(clock.getTime() + 60_000);
      await expect(
        signup(`owner${String(i)}@agency${String(i)}.example`, `Agency ${String(i)}`),
      ).resolves.toBe('counted');
    }
    clock = new Date(clock.getTime() + 60_000);
    await expect(signup('late@agency-late.example', 'Agency Late')).resolves.toBe('rate_limited');
    // A day later the cap has room again.
    clock = new Date(clock.getTime() + 25 * 3_600_000);
    await expect(signup('next@agency-next.example', 'Agency Next')).resolves.toBe('counted');

    const view = await service.view(owner);
    expect(view.signedUp).toBe(REFERRAL_COUNTED_PER_DAY + 1);
    expect(view.agencies.map((agency) => agency.name)).not.toContain('Maya side project');
    expect(view.rewards).toBeNull();
    // The twin sees nothing of Northstar's list.
    const twin = contextFor(world.twin.organizationId, world.twin.owner, 'owner');
    await expect(service.view(twin)).resolves.toMatchObject({ code: null, signedUp: 0 });

    const platform = await service.platformView(uuidv7());
    expect(platform.workspaceTotals).toEqual({
      counted: REFERRAL_COUNTED_PER_DAY + 1,
      self: 1,
      same_domain: 1,
      rate_limited: 1,
    });
  });

  it('a partner code records a partner sign-up on the platform tables', async () => {
    const service = new ReferralsService(
      tenant,
      new ReferralsRepository(),
      () => new Date('2026-11-18T12:00:00.000Z'),
      () => 'beta_free',
    );
    const partner = await service.createPartner(
      'Gulf Agency Partners',
      world.platformAdmin.id,
      uuidv7(),
      () => Promise.resolve(),
    );
    await expect(
      service.recordSignup({
        code: partner.code,
        organizationId: uuidv7(),
        organizationName: 'Dune Creative',
        email: 'hello@dune.example',
        correlationId: uuidv7(),
      }),
    ).resolves.toBe('counted');
    const platform = await service.platformView(uuidv7());
    const mine = platform.partners.find((row) => row.id === partner.id);
    expect(mine).toMatchObject({ counted: 1, name: 'Gulf Agency Partners' });
    expect(mine?.signups.map((row) => row.name)).toEqual(['Dune Creative']);
  });
});

describe('LOGQUIET sweep named locks', () => {
  it('one session at a time runs a sweep; another name is free; released after the pass', async () => {
    const first = createSweepLockDatabase({ url: db.url });
    const second = createSweepLockDatabase({ url: db.url });
    try {
      const outcome = await first.run('person-mail', async () => {
        const other = await second.run('person-mail', () => Promise.resolve('ran'));
        const different = await second.run('calendar-sync', () => Promise.resolve('ran'));
        const [held] = await rows(
          "select is_used_lock(left(concat(database(), ':sweep:', 'person-mail'), 64)) as holder",
        );
        return { other, different, held: held?.['holder'] };
      });
      expect(outcome.ran).toBe(true);
      const result = outcome.ran ? outcome.result : null;
      expect(result?.other).toEqual({ ran: false });
      expect(result?.different).toEqual({ ran: true, result: 'ran' });
      expect(result?.held).not.toBeNull();
      // Released after the pass: the other process takes it now.
      await expect(second.run('person-mail', () => Promise.resolve(1))).resolves.toEqual({
        ran: true,
        result: 1,
      });
    } finally {
      await first.end();
      await second.end();
    }
  });
});
