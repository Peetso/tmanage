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

  it('every tool domain can prepare invites on a card, refuses to swap the request, and says when the member lacks the right', () => {
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
      expect(prompt).toContain('create the client company');
      expect(prompt).toContain('You can do anything this member may do');
      expect(prompt).toContain('they do not have the right');
      expect(prompt).toContain('You prepare every change on a card');
      expect(prompt).toContain('invitations_create');
      expect(prompt).toContain('role "member"');
      expect(prompt).toContain('client_organizations_list by name or email domain');
      expect(prompt).toContain('If it does not exist, say so');
      expect(prompt).toContain('"Invite person"');
      expect(prompt).toContain('"Invite client"');
    }
  });
});
