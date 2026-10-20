import { createHash } from 'node:crypto';
import { Body, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import { NoTenant, Public } from '../../common/http/decorators.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { DcrValidationError, validateDcrRegistration } from './dcr-metadata.js';
import { DcrRateLimitError, type OAuthService } from './oauth.service.js';
import { OAUTH_SERVICE } from './oauth.tokens.js';

interface RequestLike {
  readonly ip?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

interface ReplyLike {
  status(code: number): ReplyLike;
  header(name: string, value: string): ReplyLike;
  send(payload: unknown): unknown;
}

/**
 * `POST /oauth/register` — Dynamic Client Registration (RFC 7591; MCP connector S8).
 *
 * A fallback for clients that do not do CIMD (Cursor, Gemini CLI). The body is JSON; every field
 * is validated and sanitised (`dcr-metadata.ts`, threat model B1) before a public client row is
 * written. No client secret is ever issued. The endpoint is rate limited — 10 registrations per
 * IP per hour and 1000 per day overall (T-DCR-02) — and the limit is enforced in the database so
 * it survives a restart. Public and no-tenant: registration establishes an identity rather than
 * exercising one.
 */
@Controller('oauth')
export class OAuthRegisterController {
  constructor(@Inject(OAUTH_SERVICE) private readonly oauth: OAuthService) {}

  @Post('register')
  @Public()
  @NoTenant()
  async register(
    @Req() request: RequestLike,
    @Res() reply: ReplyLike,
    @Body() body: unknown,
  ): Promise<void> {
    const { correlationId } = requireRequestState(request);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      reply.status(400).header('cache-control', 'no-store').send({
        error: 'invalid_client_metadata',
        error_description: 'The registration body must be a JSON object.',
      });
      return;
    }

    let validated;
    try {
      validated = validateDcrRegistration(body as Record<string, unknown>);
    } catch (error) {
      if (error instanceof DcrValidationError) {
        reply
          .status(400)
          .header('cache-control', 'no-store')
          .send({ error: error.code, error_description: error.description });
        return;
      }
      throw error;
    }

    const ipHash = createHash('sha256')
      .update(request.ip ?? 'unknown', 'utf8')
      .digest('hex');

    try {
      const client = await this.oauth.registerClient(
        { name: validated.name, redirectUris: validated.redirectUris, ipHash },
        correlationId,
      );
      reply
        .status(201)
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        .send({
          client_id: client.clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: client.name,
          redirect_uris: client.redirectUris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        });
    } catch (error) {
      if (error instanceof DcrRateLimitError) {
        reply
          .status(429)
          .header('cache-control', 'no-store')
          .send({ error: 'too_many_requests', error_description: error.message });
        return;
      }
      throw error;
    }
  }
}
