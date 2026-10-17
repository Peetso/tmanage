import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { API_CONFIG, AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import { FirstOwnerModule } from './first-owner.module.js';
import {
  FIRST_OWNER_ADMISSION,
  FIRST_OWNER_SERVICE,
  FIRST_OWNER_SESSIONS,
} from './first-owner.tokens.js';

/** Stand-ins for the three globals the real app module provides; nothing here touches them. */
@Global()
@Module({
  providers: [
    { provide: TENANT_DATABASE, useValue: {} },
    { provide: AUDIT_SERVICE, useValue: {} },
    {
      provide: API_CONFIG,
      useValue: { setupToken: 'test-setup-token', cookieName: 'tm_session' },
    },
  ],
  exports: [TENANT_DATABASE, AUDIT_SERVICE, API_CONFIG],
})
class FakeGlobalsModule {}

describe('FirstOwnerModule', () => {
  it('compiles and resolves its service, session service and admission limiter', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeGlobalsModule, FirstOwnerModule.register()],
    }).compile();

    expect(moduleRef.get(FIRST_OWNER_SERVICE)).toBeDefined();
    expect(moduleRef.get(FIRST_OWNER_SESSIONS)).toBeDefined();
    expect(typeof moduleRef.get(FIRST_OWNER_ADMISSION)).toBe('function');
    await moduleRef.close();
  });
});
