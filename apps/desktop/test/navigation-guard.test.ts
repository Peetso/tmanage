import { describe, expect, it } from 'vitest';
import {
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
