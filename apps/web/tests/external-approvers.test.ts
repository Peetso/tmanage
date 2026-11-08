import { describe, expect, it } from 'vitest';
import type { ExternalApprover } from '../src/components/screens/approvals/ExternalApprovalApi';
import { approverState } from '../src/components/screens/approvals/ExternalApproversPanel';
import { roughSize } from '../src/components/screens/approvals/ExternalApproverScreen';

const row = (over: Partial<ExternalApprover>): ExternalApprover =>
  ({ decision: null, linkStatus: 'active', ...over }) as ExternalApprover;

describe('52-18 external approvers (web)', () => {
  it('shows the decision first, then a closed link, else waiting', () => {
    expect(approverState(row({ decision: 'approve' })).capsule).toBe('done');
    expect(approverState(row({ decision: 'request_changes' })).english).toBe('Changes requested');
    expect(approverState(row({ linkStatus: 'revoked' })).english).toBe('Link closed');
    expect(approverState(row({ linkStatus: 'opened' })).english).toBe('Waiting');
  });

  it('gives the approver a rough file size', () => {
    expect(roughSize(2_400_000)).toBe('2.4 MB');
    expect(roughSize(512)).toBe('512 B');
    expect(roughSize(null)).toBe('');
  });
});
