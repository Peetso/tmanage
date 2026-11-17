import { describe, expect, it } from 'vitest';
import { parseFeedbackReport } from './feedback-report.js';

/** A real-shaped RFC 5965 ARF complaint returning the original message, as a feedback loop sends it. */
function arf(messageId: string, feedbackType = 'abuse', rcptTo = '<ann@client.example>') {
  return Buffer.from(
    [
      'From: <staff@hotmail.example>',
      'Date: Thu, 8 Mar 2026 14:00:00 EDT',
      'Subject: FW: You are invited',
      'To: <abuse@tm.io>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/report; report-type=feedback-report;',
      '\tboundary="part1_13d.2e68ed54_boundary"',
      '',
      '--part1_13d.2e68ed54_boundary',
      'Content-Type: text/plain; charset="US-ASCII"',
      'Content-Transfer-Encoding: 7bit',
      '',
      'This is an email abuse report for an email message received from IP',
      '192.0.2.1 on Thu, 8 Mar 2026 14:00:00 EDT. <b>never rendered</b>',
      '',
      '--part1_13d.2e68ed54_boundary',
      'Content-Type: message/feedback-report',
      '',
      `Feedback-Type: ${feedbackType}`,
      'User-Agent: SomeGenerator/1.0',
      'Version: 1',
      'Original-Mail-From: <bounces@tm.io>',
      `Original-Rcpt-To: ${rcptTo}`,
      'Arrival-Date: Thu, 8 Mar 2026 14:00:00 EDT',
      'Reported-Domain: tm.io',
      'Source-IP: 192.0.2.1',
      '',
      '--part1_13d.2e68ed54_boundary',
      'Content-Type: message/rfc822',
      'Content-Disposition: inline',
      '',
      'From: <noreply@tm.io>',
      'To: <ann@client.example>',
      'Subject: You are invited',
      `Message-ID: ${messageId}`,
      'Date: Thu, 8 Mar 2026 13:59:00 EDT',
      '',
      'Join the workspace.',
      '--part1_13d.2e68ed54_boundary--',
      '',
    ].join('\r\n'),
  );
}

describe('56-26 ARF feedback report reader', () => {
  it('reads a real-shaped spam complaint: type, returned Message-ID, Original-Rcpt-To', () => {
    expect(parseFeedbackReport(arf('<m1@tm.io>'))).toEqual({
      feedbackType: 'abuse',
      messageIds: ['<m1@tm.io>'],
      originalRcptTo: 'ann@client.example',
    });
    expect(parseFeedbackReport(arf('<m1@tm.io>', 'fraud', 'redacted'))).toMatchObject({
      feedbackType: 'fraud',
      originalRcptTo: null,
    });
  });

  it('ignores safely: not-spam, a plain message, malformed, oversized, hostile nesting', () => {
    expect(parseFeedbackReport(arf('<m1@tm.io>', 'not-spam'))).toBeNull();
    expect(parseFeedbackReport(Buffer.from('Subject: hi\r\n\r\nFeedback-Type: abuse'))).toBeNull();
    const noBoundary = arf('<m1@tm.io>').toString('latin1').replace('boundary=', 'b=');
    expect(parseFeedbackReport(Buffer.from(noBoundary, 'latin1'))).toBeNull();
    expect(parseFeedbackReport(Buffer.alloc(1024 * 1024 + 1, 0x41))).toBeNull();
    let nested = arf('<m1@tm.io>').toString('latin1');
    for (let i = 0; i < 5; i += 1) {
      nested = `Content-Type: multipart/mixed; boundary="n${String(i)}"\r\n\r\n--n${String(i)}\r\n${nested}\r\n--n${String(i)}--\r\n`;
    }
    expect(parseFeedbackReport(Buffer.from(nested, 'latin1'))).toBeNull();
    const started = Date.now();
    const hostile = `Content-Type: multipart/report; report-type=feedback-report; boundary="b"\r\n\r\n${'--b\r\n\r\n'.repeat(60000)}`;
    expect(parseFeedbackReport(Buffer.from(hostile, 'latin1'))).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
