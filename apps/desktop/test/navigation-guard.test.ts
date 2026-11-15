import { describe, expect, it } from 'vitest';
import {
  isAppOriginFrame,
  classifyAssistantNavigation,
  classifyNavigation,
  isInAppNavigation,
  shouldOpenExternally,
} from '../src/navigation-guard';

const ORIGIN = 'http://localhost:3000';

describe('classifyNavigation', () => {
  it('keeps same-origin navigation inside the app', () => {
    expect(classifyNavigation('http://localhost:3000/acme/home', ORIGIN)).toBe('allow');
    expect(classifyNavigation('http://localhost:3000/acme/chat?x=1#y', ORIGIN)).toBe('allow');
  });

  it('sends a different web origin to the system browser', () => {
    expect(classifyNavigation('https://docs.tmanage.example/help', ORIGIN)).toBe('external');
  });

  it('treats a different port or scheme as a different origin', () => {
    expect(classifyNavigation('http://localhost:4000/x', ORIGIN)).toBe('external');
    expect(classifyNavigation('https://localhost:3000/x', ORIGIN)).toBe('external');
  });

  it('hands mailto and tel links to the OS', () => {
    expect(classifyNavigation('mailto:hi@tmanage.example', ORIGIN)).toBe('external');
    expect(classifyNavigation('tel:+15550100', ORIGIN)).toBe('external');
  });

  it('blocks dangerous and non-web protocols', () => {
    expect(classifyNavigation('file:///C:/Windows/system32', ORIGIN)).toBe('block');
    expect(classifyNavigation('javascript:alert(1)', ORIGIN)).toBe('block');
    expect(classifyNavigation('data:text/html,<script>1</script>', ORIGIN)).toBe('block');
  });

  it('blocks empty or unparseable targets', () => {
    expect(classifyNavigation('', ORIGIN)).toBe('block');
    expect(classifyNavigation('://nope', ORIGIN)).toBe('block');
    // @ts-expect-error — defends against a non-string reaching the guard at runtime.
    expect(classifyNavigation(undefined, ORIGIN)).toBe('block');
  });

  it('fails closed when the app origin is misconfigured', () => {
    expect(classifyNavigation('http://localhost:3000/x', 'not-an-origin')).toBe('block');
  });

  it('works for a remote https deployment', () => {
    const remote = 'https://app.tmanage.example';
    expect(classifyNavigation('https://app.tmanage.example/acme/home', remote)).toBe('allow');
    expect(classifyNavigation('http://app.tmanage.example/acme/home', remote)).toBe('external');
  });
});

describe('guard predicates', () => {
  it('shouldOpenExternally is true only for external links', () => {
    expect(shouldOpenExternally('https://other.example/x', ORIGIN)).toBe(true);
    expect(shouldOpenExternally('http://localhost:3000/x', ORIGIN)).toBe(false);
    expect(shouldOpenExternally('file:///x', ORIGIN)).toBe(false);
  });

  it('isInAppNavigation is true only for same-origin links', () => {
    expect(isInAppNavigation('http://localhost:3000/x', ORIGIN)).toBe(true);
    expect(isInAppNavigation('https://other.example/x', ORIGIN)).toBe(false);
  });
});

describe('classifyAssistantNavigation (AI side panel)', () => {
  it('keeps the assistant, its subdomains and sign-in providers in the panel, https only', () => {
    expect(classifyAssistantNavigation('https://claude.ai/new', 'claude')).toBe('allow');
    expect(classifyAssistantNavigation('https://auth.openai.com/log-in', 'chatgpt')).toBe('allow');
    expect(classifyAssistantNavigation('https://accounts.google.com/o', 'claude')).toBe('allow');
    expect(classifyAssistantNavigation('http://claude.ai/new', 'claude')).toBe('external');
  });

  it('sends look-alikes, other sites and TManage itself out of the panel', () => {
    expect(classifyAssistantNavigation('https://claude.ai.evil.example/', 'claude')).toBe(
      'external',
    );
    expect(classifyAssistantNavigation('https://chatgpt.com/', 'claude')).toBe('external');
    expect(classifyAssistantNavigation('http://localhost:3000/acme', 'claude')).toBe('external');
    expect(classifyAssistantNavigation('javascript:alert(1)', 'claude')).toBe('block');
    expect(classifyAssistantNavigation('https://claude.ai/', 'toString')).toBe('block');
  });

  it('leaves the TManage window rules unchanged: assistants stay outward links there', () => {
    expect(classifyNavigation('https://claude.ai/new', ORIGIN)).toBe('external');
  });
});

describe('isAppOriginFrame (start-with-the-computer IPC)', () => {
  const app = 'https://tmanage.example.com';
  it('accepts only a frame on the app’s exact origin', () => {
    expect(isAppOriginFrame('https://tmanage.example.com/acme/my-day', app)).toBe(true);
    expect(isAppOriginFrame('https://evil.example.com/', app)).toBe(false);
    expect(isAppOriginFrame('https://tmanage.example.com.evil.test/', app)).toBe(false);
    expect(isAppOriginFrame('http://tmanage.example.com/', app)).toBe(false);
    expect(isAppOriginFrame('about:blank', app)).toBe(false);
    expect(isAppOriginFrame(undefined, app)).toBe(false);
    expect(isAppOriginFrame('', app)).toBe(false);
  });
});
