import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256Hex } from './audit-anchor.js';
import { approvalRecordGenesis, runApprovalChainWalk } from './approval-chain-walk.js';
import type { ApprovalChainStore, ChainRecordRow } from './approval-chain-walk.js';

const ORG = '0190a000-0000-7000-8000-000000000001';

function chain(length: number): ChainRecordRow[] {
  const rows: ChainRecordRow[] = [];
  let previous = approvalRecordGenesis(ORG);
  for (let n = 1; n <= length; n += 1) {
    const evidence = {
      schema: 'tmanage.approval.record.v1',
      recordNo: n,
      previousRecordHash: previous,
      organizationId: ORG,
      approvalId: `a-${n}`,
      deliverableVersionId: 'v-1',
      approver: { userId: 'u-1', kind: 'client' },
      decision: 'approved',
      comment: null,
    };
    const recordJson = canonicalJson(evidence);
    const recordHash = sha256Hex(recordJson);
    rows.push({
      recordNo: n,
      recordHash,
      previousRecordHash: previous,
      recordJson,
      signature: null,
      approvalId: `a-${n}`,
      deliverableVersionId: 'v-1',
      approverUserId: 'u-1',
      approverKind: 'client',
      decision: 'approved',
    });
    previous = recordHash;
  }
  return rows;
}

function store(rows: readonly ChainRecordRow[]) {
  const recordBreak = vi.fn<ApprovalChainStore['recordBreak']>(() => Promise.resolve());
  const fake: ApprovalChainStore = {
    organizations: () => Promise.resolve([ORG]),
    records: (_org, after, limit) =>
      Promise.resolve(rows.filter((r) => r.recordNo > after).slice(0, limit)),
    recordBreak,
  };
  return { fake, recordBreak };
}

describe('52-19 approval chain walk', () => {
  it('passes an intact chain and reports an edited record as a high signal', async () => {
    const intact = store(chain(5));
    const ok = await runApprovalChainWalk({
      store: intact.fake,
      verifySignature: () => null,
      batch: 2,
    });
    expect(ok).toMatchObject({ ok: 1, broken: 0 });
    expect(intact.recordBreak).not.toHaveBeenCalled();

    const rows = chain(5);
    const edited = rows[2] as ChainRecordRow;
    rows[2] = { ...edited, recordJson: edited.recordJson.replace('approved', 'changes_requested') };
    const tampered = store(rows);
    const result = await runApprovalChainWalk({
      store: tampered.fake,
      verifySignature: () => null,
      batch: 2,
    });
    expect(result).toMatchObject({ ok: 0, broken: 1 });
    expect(tampered.recordBreak).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        ruleKey: 'approval_chain_break',
        severity: 'high',
        breakRecordNo: 3,
        reason: 'hash_mismatch',
      }),
    );
  });
});
