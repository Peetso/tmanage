/**
 * FIX6 C1. Reading a provider's download into memory without ever holding more than the cap.
 *
 * A `content-length` over the cap is refused before the body is touched; without one the stream
 * is read chunk by chunk and cancelled the moment the total passes the cap, so a provider that
 * lies about the size (or sends none) still cannot make the server buffer more than `maxBytes`.
 */

/** The download is larger than the organization allows one file to be. */
export class DownloadTooLargeError extends Error {
  override name = 'DownloadTooLargeError';
}

export async function readCappedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new DownloadTooLargeError(`declared ${declared} bytes, the cap is ${maxBytes}`);
  }
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DownloadTooLargeError(`more than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
