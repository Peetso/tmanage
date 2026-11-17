/**
 * IndexNow (SEO plan T6, slice B9): the site tells Bing and the other IndexNow engines which of its
 * addresses changed, instead of waiting for them to crawl. The key is the site's proof that it owns
 * the host. It is never in the code: it comes from the {@link INDEXNOW_KEY_ENV} environment
 * variable, which the server and the person running `scripts/indexnow-ping.mjs` both set.
 *
 * The key is served at one fixed address, {@link INDEXNOW_KEY_PATH}, and every ping names it as
 * `keyLocation`, as the protocol allows; at the site root, it covers every address on the host.
 *
 * No imports: `scripts/indexnow-ping.mjs` loads this file with plain Node.
 */

/** The environment variable that holds the IndexNow key. */
export const INDEXNOW_KEY_ENV = 'INDEXNOW_KEY';

/** Where the site serves its key, as `text/plain`. */
export const INDEXNOW_KEY_PATH = '/indexnow-key.txt';

/** The protocol's key format: 8 to 128 letters, digits and dashes. */
const KEY_FORMAT = /^[A-Za-z0-9-]{8,128}$/;

/** The configured key, or `undefined` when it is missing or not in the protocol's format. */
export function indexNowKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  return key !== undefined && KEY_FORMAT.test(key) ? key : undefined;
}
