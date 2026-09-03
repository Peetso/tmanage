import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Optional,
  Param,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { PartTooLargeError } from '@tmanage/storage';
import type { PartSink, PutPartResult } from '@tmanage/storage';
import { NoTenant, Public } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { PART_CONTENT_TYPE } from '../../common/http/fastify-adapter.js';
import { LOCAL_PART_SINK } from '../../common/http/tokens.js';

/**
 * FILE-001b's transport — the one route in this API that a browser reaches with no session.
 *
 * `PUT /v1/uploads/:providerUploadId/parts/:n?t=…` is what `FilesystemObjectStore` mints as
 * an upload target, the local stand-in for a presigned S3 URL. A presigned URL is honoured by
 * the bucket, not by the API; here the API is the bucket, so this controller is `@Public()`
 * — no session, no CSRF (the token is bound to nothing a cookie carries) — and `@NoTenant()`
 * — the path names no organization and the request resolves none. It does no authorization
 * of its own. The token, the handle, the part number and whether the upload still exists are
 * all decided inside the driver (`PartSink.putPart`), because the manifest it reads is the
 * revocation, and half an authorization in a file that cannot see the manifest is none.
 *
 * Every refusal the sink makes is one `null`, and every `null` is one 404 with one body —
 * a forged token, an expired one, an aborted upload, a completed one, a part number the
 * upload does not have. Distinguishing them would tell a prober which handles exist. A body
 * over the part size is the one refusal with its own status, 413, because it is not about
 * authority: the caller holds a valid token and sent more than one part may carry.
 *
 * What this route never does: read a `TenantContext` or a `Principal` (there is neither),
 * echo the object key or the handle in a response (the `ETag` is the only thing it says),
 * or sit under `/portal` or `/v1/organizations` where an interceptor would walk a `Buffer`.
 *
 * The sink is injected `@Optional()`: only `StorageModule.forConfig` with the filesystem
 * driver provides it. A suite holding the fake, or a deployment on `s3`, leaves it unbound
 * and this route answers 404 to everything — the same body an unknown handle gets.
 */

/** A part number is one to five digits with no leading zero; anything else is not a part. */
const PART_NUMBER = /^[1-9]\d{0,4}$/;

interface HeaderWriter {
  header(name: string, value: string): unknown;
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'upload_part_refused');
}

@Controller('v1/uploads')
@Public()
@NoTenant()
export class UploadPartsController {
  constructor(@Optional() @Inject(LOCAL_PART_SINK) private readonly sink: PartSink | undefined) {}

  @Put(':providerUploadId/parts/:n')
  @HttpCode(200)
  async put(
    @Param('providerUploadId') providerUploadId: string,
    @Param('n') n: string,
    @Query('t') token: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<void> {
    if (!Buffer.isBuffer(body)) {
      // The octet-stream parser is the only one that yields a Buffer. A JSON body here is a
      // client bug, and saying so reveals nothing about any upload.
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'body', message: `must be sent as ${PART_CONTENT_TYPE}` },
      ]);
    }
    if (!this.sink || !PART_NUMBER.test(n)) throw notFound();

    let result: PutPartResult | null;
    try {
      result = await this.sink.putPart({
        providerUploadId,
        partNumber: Number(n),
        token: typeof token === 'string' ? token : undefined,
        body,
      });
    } catch (error) {
      if (error instanceof PartTooLargeError) {
        throw new ApiError(
          413,
          'validation_failed',
          'The request body is invalid',
          [{ field: 'body', message: 'exceeds the part size' }],
          'part_too_large',
        );
      }
      throw error;
    }
    if (!result) throw notFound();

    // Quoted, as S3 quotes it; the driver strips the quotes again at completion.
    reply.header('etag', `"${result.etag}"`);
  }
}
