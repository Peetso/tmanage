import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { SessionAuthGuard } from '../../common/http/guards/session-auth.guard.js';
import {
  API_CONFIG,
  AUTHENTICATION_EVENT_RECORDER,
  PERSONAL_ACCESS_TOKEN_AUTHENTICATOR,
  SESSION_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import { McpOAuthAuthenticator } from './mcp-auth.js';
import { McpEndpointModule } from './mcp-endpoint.controller.js';

/**
 * The wiring FX2 relies on: `SessionAuthGuard` is a root-module guard, and it can accept OAuth
 * access tokens on `/mcp` only if `McpEndpointModule` exports the authenticator to the root. The
 * guard takes it as `@Optional()`, so a missing export would not fail boot — it would silently
 * turn OAuth off. This holds the export in place.
 */

@Global()
@Module({
  providers: [
    { provide: TENANT_DATABASE, useValue: {} },
    { provide: API_CONFIG, useValue: { cookieName: 'tm', apiPublicUrl: 'https://t.example' } },
  ],
  exports: [TENANT_DATABASE, API_CONFIG],
})
class FakeInfrastructure {}

describe('McpEndpointModule wiring', () => {
  it('hands the OAuth access-token authenticator to the root-level SessionAuthGuard', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeInfrastructure, McpEndpointModule.register()],
      providers: [
        Reflector,
        SessionAuthGuard,
        { provide: SESSION_SERVICE, useValue: {} },
        { provide: AUTHENTICATION_EVENT_RECORDER, useValue: {} },
        { provide: PERSONAL_ACCESS_TOKEN_AUTHENTICATOR, useValue: {} },
      ],
    }).compile();
    const guard = moduleRef.get(SessionAuthGuard);
    expect((guard as unknown as { mcpOAuth?: unknown }).mcpOAuth).toBeInstanceOf(
      McpOAuthAuthenticator,
    );
  });
});
