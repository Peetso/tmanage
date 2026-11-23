import { describe, expect, it } from 'vitest';

import { domainSystemPrompt } from './domains.js';
import { ROUTER_SYSTEM_PROMPT } from './router.js';

// 2026-11-23 live: "عايزك تعمل انفايت ل… كموظف و … ككلاينت" (invite one employee and one client)
// was routed to billing and answered as an invoice.
describe('prompts read Arabic and Franco requests by meaning', () => {
  it('the router maps the Arabic-letter "invite" to people or clients, never to billing', () => {
    expect(ROUTER_SYSTEM_PROMPT).toContain('انفايت');
    expect(ROUTER_SYSTEM_PROMPT).toMatch(/invite \/ انفايت[^\n]*never an invoice/);
    expect(ROUTER_SYSTEM_PROMPT).toContain('inviting a teammate or employee');
    expect(ROUTER_SYSTEM_PROMPT).toContain('inviting a client');
  });

  it('every tool domain refuses to swap the request and says where to do it instead', () => {
    for (const domain of [
      'tasks',
      'projects',
      'people',
      'clients',
      'time',
      'billing',
      'files',
    ] as const) {
      const prompt = domainSystemPrompt(domain);
      expect(prompt).toContain('Never swap their request for a different action');
      expect(prompt).toContain('"Invite person"');
      expect(prompt).toContain('"Invite client"');
    }
  });
});
