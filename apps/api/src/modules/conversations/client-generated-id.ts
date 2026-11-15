/**
 * ACCOUNT item 2: the one rule for a message's send-attempt key (`clientGeneratedId`), shared by
 * the channel and the direct-message post routes. Absent (or `null`) is fine: no dedupe. Present, it must be
 * a short opaque id — letters, digits and dashes, at most the column's 36 characters — so it is
 * stored as given and a retry with the same key always finds the first message.
 */
const CLIENT_GENERATED_ID = /^[A-Za-z0-9-]{1,36}$/u;

export const CLIENT_GENERATED_ID_RULE =
  'must be letters, digits and dashes, 36 characters or fewer';

export function isClientGeneratedId(value: unknown): value is string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && CLIENT_GENERATED_ID.test(value))
  );
}
