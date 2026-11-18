import { randomBytes } from 'node:crypto';
import { uuidv7 } from '@tmanage/domain';
import { createPool } from 'mysql2/promise';
import type { ResultSetHeader } from 'mysql2/promise';

/**
 * Plant one approval record whose stored fingerprint no longer matches its own content — the e2e
 * harness's way of showing the public /verify page an *altered* record. Nothing in the product
 * can produce one (the chain is append-only and written only by the decision path), which is the
 * point: this is the tampering the page exists to expose, done the way an attacker with database
 * access would, as `testdb-1118-growth-records.db.test.ts` does for the DB suite.
 *
 * The row takes its organization's next `record_no`, so pass an organization no journey reads a
 * chain of: a forged row reads as a break to every later chain check of that tenant, and the
 * journeys share one database. `record_hash` is random hex, so it is not the hash of
 * `record_json` and the verifier's hash check fails for certain.
 *
 * Usage: `tsx test/forge-approval-record-cli.ts <organizationId> <approverUserId>` with
 * `TMANAGE_SEED_DATABASE_URL` set. stdout is the contract: one JSON line
 * `{ recordId, fingerprint }`. Test tooling only; nothing in any runtime path invokes it.
 */
const url = process.env['TMANAGE_SEED_DATABASE_URL'];
const [organizationId, approverUserId] = process.argv.slice(2);
if (!url) {
  console.error('TMANAGE_SEED_DATABASE_URL is not set');
  process.exit(1);
}
if (!organizationId || !approverUserId) {
  console.error('usage: forge-approval-record-cli <organizationId> <approverUserId>');
  process.exit(1);
}

const recordId = uuidv7();
const fingerprint = randomBytes(32).toString('hex');
const pool = createPool({ uri: url, connectionLimit: 1, timezone: 'Z' });
try {
  const [result] = await pool.execute<ResultSetHeader>(
    `insert into approval_records (id, organization_id, approval_id, deliverable_version_id, record_no,
       approver_user_id, approver_kind, decision, record_json, record_hash, previous_record_hash, created_at)
     select ?, ?, ?, ?, coalesce(max(record_no), 0) + 1, ?, 'internal', 'approved', ?, ?, repeat('0', 64), ?
       from approval_records where organization_id = ?`,
    [
      recordId,
      organizationId,
      uuidv7(),
      uuidv7(),
      approverUserId,
      JSON.stringify({ forged: true }),
      fingerprint,
      new Date(),
      organizationId,
    ],
  );
  process.stdout.write(`${JSON.stringify({ recordId, fingerprint })}\n`);
  if (result.affectedRows !== 1) process.exitCode = 1;
} finally {
  await pool.end();
}
