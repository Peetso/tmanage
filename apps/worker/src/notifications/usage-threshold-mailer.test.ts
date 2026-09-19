import { describe, expect, it } from 'vitest';
import { composeUsageThresholdEmail } from './usage-threshold-mailer.js';

/** The pure copy of the usage mail — the warning bands read differently from the 100 block. */
describe('composeUsageThresholdEmail', () => {
  const facts = {
    recipientEmail: 'o@x',
    recipientName: 'Owner',
    used: 8_000_000_000,
    reserved: 500_000_000,
    quota: 10_000_000_000,
  };

  it('a warning band names the percentage and the used-of-quota figure', () => {
    const message = composeUsageThresholdEmail({ ...facts, band: 85 });
    expect(message.to).toBe('o@x');
    expect(message.subject).toContain('85%');
    expect(message.text).toMatch(/85% \([\d.]+ GB of [\d.]+ GB\)/u);
  });

  it('band 100 says uploads are blocked, not merely near a limit', () => {
    const message = composeUsageThresholdEmail({ ...facts, band: 100 });
    expect(message.subject).toContain('full');
    expect(message.text).toContain('blocked');
  });
});
