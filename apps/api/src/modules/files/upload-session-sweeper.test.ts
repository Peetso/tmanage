import { describe, expect, it } from 'vitest';
import { describeFailure } from './upload-session-sweeper.js';

describe('what the sweeper logs when a release fails', () => {
  it('keeps the name and the code of a driver error, and drops its message', () => {
    const driver = Object.assign(new Error("Duplicate entry 'brief.pdf' for key 'uq_example'"), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlState: '23000',
      sqlMessage: "Duplicate entry 'brief.pdf' for key 'uq_example'",
    });
    // Reversal: log the message for a driver error too and 'brief.pdf' is on stderr.
    expect(describeFailure(driver)).toEqual({ name: 'Error', code: 'ER_DUP_ENTRY', errno: 1062 });
  });

  it('keeps the message of an application error, which names a state and not a row', () => {
    const own = new Error('illegal transition reserved -> expired');
    own.name = 'UploadSessionTransitionError';
    expect(describeFailure(own)).toEqual({
      name: 'UploadSessionTransitionError',
      message: 'illegal transition reserved -> expired',
    });
    expect(describeFailure('a string')).toEqual({ kind: 'string' });
  });
});
