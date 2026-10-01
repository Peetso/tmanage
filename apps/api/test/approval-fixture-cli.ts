import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { createTenantPool } from '../src/common/database/connection.js';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../src/common/database/tenant-context.js';
import type { ClientProjectionPayload } from '../src/common/database/schema.js';
import { DeliverableVersionsRepository } from '../src/modules/approvals/deliverable-versions.repository.js';
import { ApprovalsRepository } from '../src/modules/approvals/approvals.repository.js';
import { ClientProjectionsRepository } from '../src/modules/approvals/client-projections.repository.js';

/**
 * E2E-05's approval fixture (T001). The running stack has no HTTP route that mints a
 * `deliverable_versions` row — a version is an internal content-identity row written only from
 * tests (see `deliverable-versions.repository.ts`) — so the client deep-link decide journey has
 * nothing to open against until this CLI seeds one. Spawned from `e2e/setup/stack.ts` the way
 * `ageUploadSession`/`seed-cli` are: through this package's own database client, because the e2e
 * package deliberately holds none.
 *
 * It builds, through the real tenant-scoped repositories (so the state machine, the tenant guard,
 * and the append-only lifecycle all apply exactly as they do in production), **two** independent
 * fixtures — a governed `deliverable_versions` row, an `approvals` row opened over it at
 * `requested`, and a published `client_projections` row naming the Atlas contact. Two, so E2E-05b
 * requests changes on a different version than E2E-05a approved and the serial cases never fight
 * over one append-only approval (the journey header's reasoning).
 *
 * Dates are bound `Date` values inside the repositories, never the connection's `current_timestamp`
 * (the admin/pool clock trap). Each fixture uses its own `deliverableId`, so the decision's hash
 * re-check against the deliverable's *latest* governed version resolves to this exact version.
 *
 * Usage: `tsx test/approval-fixture-cli.ts <organizationId> <projectId> <publisherUserId>
 * <publisherMembershipId> <approvedContactEmail>` with `TMANAGE_SEED_DATABASE_URL` set. Positional
 * args (not a JSON blob) because `e2e/setup/stack.ts` spawns through a shell on Windows, and these
 * tokens — UUIDs and an email — carry nothing a shell would re-interpret. stdout is the contract:
 * exactly one JSON line `{ deliverableVersionId, secondDeliverableVersionId }`. Test tooling only.
 */

interface FixtureConfig {
  readonly organizationId: string;
  readonly projectId: string;
  readonly publisherUserId: string;
  readonly publisherMembershipId: string;
  readonly approvedContactEmail: string;
}

const url = process.env['TMANAGE_SEED_DATABASE_URL'];
const [organizationId, projectId, publisherUserId, publisherMembershipId, approvedContactEmail] =
  process.argv.slice(2);
if (!url) {
  console.error('TMANAGE_SEED_DATABASE_URL is not set');
  process.exit(1);
}
if (
  !organizationId ||
  !projectId ||
  !publisherUserId ||
  !publisherMembershipId ||
  !approvedContactEmail
) {
  console.error(
    'usage: approval-fixture-cli <organizationId> <projectId> <publisherUserId> ' +
      '<publisherMembershipId> <approvedContactEmail>',
  );
  process.exit(1);
}

const config: FixtureConfig = {
  organizationId,
  projectId,
  publisherUserId,
  publisherMembershipId,
  approvedContactEmail,
};

const versions = new DeliverableVersionsRepository();
const approvals = new ApprovalsRepository();
const projections = new ClientProjectionsRepository();

function projectionPayload(title: string, contactEmail: string): ClientProjectionPayload {
  return {
    title,
    summary: 'The published direction for your review.',
    milestoneState: 'in_review',
    forecastDate: '2026-10-15',
    publishedRisk: 'on_track',
    // Not yet decided — the client decides on the deep link; the projection carries no outcome.
    decision: null,
    approvedContacts: [contactEmail],
  };
}

/**
 * Seed one governed version, open its approval at `requested`, and publish its client projection —
 * all in one transaction, through the scoped repositories. Returns the governed version id the deep
 * link is addressed by. The content hash is shared across the three rows (as the service's own
 * publish does), so the decision's INT-16 re-check matches rather than invalidates.
 */
async function seedOne(
  tx: TenantQueryRunner,
  context: TenantContext,
  title: string,
  contentHash: string,
): Promise<string> {
  const deliverableId = uuidv7();
  const version = await versions.create(tx, context, {
    projectId: config.projectId,
    deliverableId,
    contentHash,
    createdByUserId: config.publisherUserId,
  });
  await approvals.open(tx, context, {
    projectId: version.projectId,
    deliverableId: version.deliverableId,
    deliverableVersionId: version.id,
    contentHash: version.contentHash,
    // The internal reviewer relation; a client's authority to decide is the project relation
    // instead (approvals.service `clientDecide`), so this list is never a client.
    reviewerIds: [config.publisherUserId],
  });
  await projections.publish(tx, context, {
    projectId: version.projectId,
    deliverableId: version.deliverableId,
    deliverableVersionId: version.id,
    contentHash: version.contentHash,
    projection: projectionPayload(title, config.approvedContactEmail),
    publishedByUserId: config.publisherUserId,
  });
  return version.id;
}

const pool = createTenantPool({ url, connectionLimit: 1, statementTimeoutMs: 15_000 });
const database = new TenantDatabase(pool, { guardMode: 'enforce' });
const context = createTenantContext({
  organizationId: config.organizationId,
  userId: config.publisherUserId,
  membershipId: config.publisherMembershipId,
  principalKind: 'internal',
  capabilities: capabilitiesFor('manager'),
  policyVersion: 'e2e-approval-fixture',
  correlationId: uuidv7(),
});

try {
  const deliverableVersionId = await database.transaction(context, (tx) =>
    seedOne(tx, context, 'Atlas Website — Homepage concept', 'a'.repeat(64)),
  );
  const secondDeliverableVersionId = await database.transaction(context, (tx) =>
    seedOne(tx, context, 'Atlas Website — Booking flow', 'b'.repeat(64)),
  );
  // stdout is the contract: the caller parses exactly one JSON line.
  process.stdout.write(`${JSON.stringify({ deliverableVersionId, secondDeliverableVersionId })}\n`);
} finally {
  await database.end();
}
