import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectAiHelpScreen,
  claudeCodeCommand,
  cursorEntry,
} from '../src/components/screens/ConnectAiHelpScreen';
import { connectorAddress, openApiAddress } from '../src/lib/ai-connector-address';
import { expectNoAxeViolations } from './axe';

// Assertions read addresses and snippets, never catalog prose, so they hold in either locale.

function mount() {
  return render(
    <ConnectAiHelpScreen
      organizationSlug="northstar"
      organizationName="Acme Agency"
      serverUrl="https://tmanage.example.test/"
      accountLabel="ops@acme.test"
    />,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('ConnectAiHelpScreen', () => {
  it('shows this deployment address, every snippet and the OpenAPI download, axe-clean', async () => {
    const { container } = mount();

    expect(screen.getByTestId('tm-aihelp-address').textContent).toBe(
      'https://tmanage.example.test/mcp',
    );
    expect(screen.getByTestId('tm-aihelp-claude-code').textContent).toBe(
      'claude mcp add --transport http tmanage https://tmanage.example.test/mcp',
    );
    expect(screen.getByTestId('tm-aihelp-cursor').textContent).toBe(
      '"tmanage": { "url": "https://tmanage.example.test/mcp" }',
    );
    expect(screen.getByTestId('tm-aihelp-download').getAttribute('href')).toBe(
      'https://tmanage.example.test/openapi/ai.json',
    );
    expect(screen.getByTestId('tm-aihelp-account').textContent).toBe('ops@acme.test');
    expect(screen.getByText(/Acme Agency\.$/)).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(5);

    await expectNoAxeViolations(container);
  });

  it('copies exactly the text shown', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    mount();

    fireEvent.click(screen.getByTestId('tm-aihelp-copy-address'));
    fireEvent.click(screen.getByTestId('tm-aihelp-claude-code-copy'));
    fireEvent.click(screen.getByTestId('tm-aihelp-copy-openapi'));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(3));
    expect(writeText.mock.calls.map((call) => call[0])).toEqual([
      'https://tmanage.example.test/mcp',
      'claude mcp add --transport http tmanage https://tmanage.example.test/mcp',
      'https://tmanage.example.test/openapi/ai.json',
    ]);
  });
});

describe('connector addresses', () => {
  it('builds the MCP and OpenAPI addresses without a double slash', () => {
    expect(connectorAddress('https://a.test//')).toBe('https://a.test/mcp');
    expect(openApiAddress('https://a.test/')).toBe('https://a.test/openapi/ai.json');
    expect(claudeCodeCommand('https://a.test/mcp')).toBe(
      'claude mcp add --transport http tmanage https://a.test/mcp',
    );
    expect(JSON.parse(`{${cursorEntry('https://a.test/mcp')}}`)).toEqual({
      tmanage: { url: 'https://a.test/mcp' },
    });
  });
});
