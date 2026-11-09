import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  SEQUENCE_TIMEOUT_MS,
  SHORTCUTS,
  ShortcutMatcher,
  isTypingTarget,
  keyToken,
} from '../src/lib/keyboard/shortcut-layer';
import { KeyboardShortcutLayer } from '../src/components/shell/KeyboardShortcutLayer';
import { OPEN_COMMAND_PALETTE_EVENT } from '../src/components/screens/CommandPalette';
import { BoardMoveMenu } from '../src/components/screens/WorkBoardView';

/** Slice 55-12 — the global shortcut layer, its cheat sheet, and the board's drag alternative. */

describe('keyToken', () => {
  it('reads Latin keys, and the physical key on an Arabic layout', () => {
    expect(keyToken({ key: 'g', code: 'KeyG' })).toBe('g');
    expect(keyToken({ key: 'ل', code: 'KeyG' })).toBe('g');
    expect(keyToken({ key: 'ظ', code: 'Slash' })).toBe('/');
    expect(keyToken({ key: '؟', code: 'Slash', shiftKey: true })).toBe('?');
    expect(keyToken({ key: 'Escape' })).toBe('esc');
    expect(keyToken({ key: 'k', ctrlKey: true })).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('is true in text fields and editors, false on buttons', () => {
    const input = document.createElement('input');
    const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox' });
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const inner = document.createElement('p');
    editor.append(inner);
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(inner)).toBe(true);
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
  });
});

describe('B-N2 (live check fd145807): no single-key shortcut while a doc is being written', () => {
  it('stays quiet in a writing surface, and on the page itself while one is open', () => {
    const navigate = vi.fn();
    render(<KeyboardShortcutLayer organizationSlug="northstar" navigate={navigate} />);
    const surface = document.createElement('div');
    surface.setAttribute('data-tm-typing-surface', '');
    const toolbarButton = document.createElement('button');
    surface.append(toolbarButton);
    const main = document.createElement('main');
    main.tabIndex = -1;
    document.body.append(surface, main);
    // Focus fell on <main> (a click missed the editor): "g h" is typing, not "go home".
    press('g', {}, main);
    press('h', {}, main);
    press('c', {}, document.body);
    press('g', {}, toolbarButton);
    press('h', {}, toolbarButton);
    expect(navigate).not.toHaveBeenCalled();
    surface.remove();
    press('g', {}, main);
    press('h', {}, main);
    expect(navigate).toHaveBeenCalledWith('/northstar/home');
    main.remove();
  });
});

describe('ShortcutMatcher', () => {
  it('completes g sequences within the timeout and drops stale ones', () => {
    const m = new ShortcutMatcher();
    expect(m.feed('g', 0)).toBeNull();
    expect(m.feed('w', 100)).toBe('goWork');
    expect(m.feed('g', 1000)).toBeNull();
    expect(m.feed('h', 1000 + SEQUENCE_TIMEOUT_MS + 1)).toBeNull();
    expect(m.feed('g', 5000)).toBeNull();
    expect(m.feed('x', 5001)).toBeNull();
    expect(m.feed('c', 5002)).toBe('create');
  });
});

function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body) {
  fireEvent.keyDown(target, { key, ...init });
}

describe('KeyboardShortcutLayer', () => {
  it('navigates on g sequences and c, opens search on /', () => {
    const navigate = vi.fn();
    const onSearch = vi.fn();
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onSearch);
    render(<KeyboardShortcutLayer organizationSlug="northstar" navigate={navigate} />);
    press('g');
    press('p');
    press('ل', { code: 'KeyG' });
    press('ح', { code: 'KeyH' });
    press('c');
    press('/');
    expect(navigate.mock.calls.map(([path]) => path)).toEqual([
      '/northstar/projects/portfolio',
      '/northstar/home',
      '/northstar/capture',
    ]);
    expect(onSearch).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onSearch);
  });

  it('never fires while typing in a field', () => {
    const navigate = vi.fn();
    render(
      <>
        <input aria-label="Title" />
        <KeyboardShortcutLayer organizationSlug="northstar" navigate={navigate} />
      </>,
    );
    const field = screen.getByLabelText('Title');
    press('g', {}, field);
    press('w', {}, field);
    press('?', {}, field);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ShortcutCheatSheet', () => {
  it('lists every shortcut by section, traps focus, and returns it on Escape', () => {
    render(
      <>
        <button type="button">Opener</button>
        <KeyboardShortcutLayer organizationSlug="northstar" navigate={vi.fn()} />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    press('?', {}, opener);
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getAllByRole('heading', { level: 3 })).toHaveLength(3);
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(SHORTCUTS.length);
    expect(within(dialog).getByText('Go to Work')).toBeTruthy();
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    press('Escape', {}, close);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('BoardMoveMenu (2.5.7 dragging alternative)', () => {
  it('moves to the chosen column and returns focus on Escape', async () => {
    const onMove = vi.fn();
    render(<BoardMoveMenu title="Hero copy" current="todo" onMove={onMove} />);
    const button = screen.getByRole('button', { name: 'Move Hero copy' });
    fireEvent.click(button);
    expect((screen.getByRole('button', { name: /current/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    const items = screen.getAllByRole('button').filter((el) => el !== button);
    fireEvent.click(items[1] as HTMLElement);
    await waitFor(() => expect(onMove).toHaveBeenCalledWith('in_progress'));
  });
});
