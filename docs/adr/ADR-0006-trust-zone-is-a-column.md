# ADR-0006 — The trust zone is a column, and the object key is stable across zones

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** Implementation lead, under Peter's delegation of decision F1 (2026-09-05)
- **Governing sources:** `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY.md` §4 (three trust
  zones; an object is promoted once validation and scan pass) and §5 (a rejected object's
  bytes stay counted until deletion); `03-TECHNICAL-ARCHITECTURE.md` §108 (unscanned uploads
  are quarantined; buckets by trust state); `23-ERD-AND-STATE-MACHINES.md` §10
  (`scanning → ready | rejected`; inaccessible until `ready`); `26-THREAT-MODELS-AND-DATA-FLOWS.md`
  §5 (:79 — immutable keys, quarantine, checksum); `04-SECURITY-PRIVACY.md` §6;
  `50-BOOTSTRAP-DEPLOYMENT-ON-ONE-PAID-PLAN.md` §39 (scanning flagged or conservative in
  private alpha); ADR-0001 layer 5
- **Evidence:** `apps/api/migrations/0019_file_versions_scan_and_trust_zone.sql`;
  `apps/api/src/modules/files/file-scanner.ts`; `packages/storage/src/object-store.ts`
  (`promote`, `withdraw`); `apps/api/test/file-002-scanning.db.test.ts`

## Context

`49` §4 describes three storage layouts — quarantine, private, derived — and has an object
**move** from the quarantine layout to the private one when validation and the malware scan
pass. Read literally, promotion changes the object's key: the quarantine key names the
upload, the private key names the served object.

The schema built for FILE-001 disagrees with that reading before slice B was written.
Migration 0015 made `file_versions.object_key` immutable at the engine (a `BEFORE UPDATE`
trigger, re-created by 0018 and again by 0019), on `26` §5's ground (:79, "immutable keys") that a mutable key is
the one loophole an "immutable identity" trigger cannot close: whoever may change the key
may point a `ready` row at bytes no scanner ever saw. FILE-002 slice A then made
`content_hash` write-once on the same row. A key that changes at promotion would have to
be either a second column (two keys per version, one of them always stale) or a permitted
UPDATE of the pinned one.

Slice B also had to decide **how** the bytes reach the private zone. The plan copied the
sealed quarantine object after a clean verdict — a second read of the same key, and the
adversarial fleet's first refutation (D1): between the scan's read and the copy's read the
object can be replaced, and the private zone would then hold bytes the scanner did not
clear. The filesystem driver's regular-file check narrows that window; it does not close it.

## Decision

**The trust zone is a column on `file_versions` (`trust_zone`, `quarantine` or `private`),
and the object key is one value for the life of the version.** Promotion does not rename
or re-key anything: the scan pass streams the bytes it is reading — the same stream that
feeds the digest and the scanner — into a staging sink under the **same key** in the
private zone, and commits it only after the scanner's `clean` and the digest's match with
`content_hash`. The row then says `trust_zone = 'private'`, in the same UPDATE that records
the verdict, and 0019's trigger admits that move only with `scan_verdict = 'clean'`, only
from `quarantine`, and never back.

Consequences that follow, each deliberate:

1. **Promotion is streamed, not copied.** `ObjectStore.promote` returns a sink and a
   one-shot `commit`/`abort`; the bytes in `private` are, by construction, the bytes the
   scanner cleared, because they are the same read. No second `openObject` happens.
2. **The object exists twice until FILE-003 deletes the quarantine copy** of a `ready`
   version. The duplicate is accepted for reconciliation (H5): a `ready` row whose private
   object is missing can be re-promoted from quarantine, and a rejected row's quarantine
   object stays counted (`49` §5, decision F4). Storage accounting counts the version once;
   the quarantine copy's lifetime is FILE-003's.
3. **The download path reads the zone from the row**, never from a literal. Slice C's
   `isServable` will require `status = 'ready'`, `trust_zone = 'private'` and
   `scan_verdict = 'clean'` on the latest version together; the engine already refuses
   `ready` without the last two.
4. **`withdraw` is the one undo**: it removes a private object under a key and nothing
   else. It runs after a rejection (a crashed earlier run may have sealed the object before
   it could conclude) and when a pass loses a dispute to a standing `infected`. It never
   touches quarantine.
5. **Under `MALWARE_SCAN_DRIVER=none`** (decision F3) no version ever reaches `private`
   and no asset ever reaches `ready`: the pass records `unscanned` once and leaves the row
   at `scanning`. The bootstrap profile therefore stores uploads and serves none of them
   until a real scanner is configured — the conservative reading of `50` §39, and a
   divergence from `04` §6 / `26` §5, which assume a scan happens.

## Divergences recorded

- **From `49` §4's three key layouts.** One key, three zones-as-state. The `derived` zone
  is not a value `trust_zone` admits: previews are FILE-004's own rows with their own keys,
  never a state of the original version.
- **From `04` §6 and `26` §5 under `none`.** Both assume every upload is scanned before it
  is served. Under `none` nothing is served, which is stricter than they ask and less
  useful than they assume; the honest statement is in `50` §39 and in the pass's
  `file_asset.scan_failed` row with cause `no_scanner`.
- **From `49` :72's separate quarantine identity** (decision F2, paid beta): the API
  identity writes to `private`. The bucket-policy split that would make promotion a
  privilege of a different credential is deferred with F2, and recorded in
  `docs/implementation-status.md` as carried (D14).

## Alternatives considered

- **Re-key at promotion, as `49` §4 reads.** Rejected: it needs a mutable `object_key` or
  a second key column, and either re-opens the loophole 0015 closed for `26` §5.
- **Copy after the verdict.** Rejected by the fleet's D1: a second read is a second chance
  for the bytes to differ. The filesystem driver's `isFile()` check would narrow, not close,
  the window; an S3 driver has no such check at all.
- **A `derived` value on `trust_zone`.** Rejected: a preview is a different object with a
  different lifetime and a different consumer, and folding it into the original's state
  would let a derived-only version look promoted.
- **Delete the quarantine copy at commit.** Rejected for slice B: it removes the only
  recovery path for a promotion whose commit succeeded on disk but whose transaction
  failed, and `49` §5 wants rejected bytes to stay counted anyway. FILE-003 owns deletion.
