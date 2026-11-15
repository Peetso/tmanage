import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDragPan } from '../src/components/viewer/drag-pan';

function Box({ enabled }: { readonly enabled: boolean }) {
  const pan = useDragPan(enabled);
  return (
    <div data-testid="box" data-panning={pan.panning ? 'true' : undefined} {...pan.handlers}>
      <button type="button">Pin</button>
    </div>
  );
}

function sized(box: HTMLElement, overflow: boolean): HTMLElement {
  Object.defineProperty(box, 'clientWidth', { value: 400 });
  Object.defineProperty(box, 'clientHeight', { value: 300 });
  Object.defineProperty(box, 'scrollWidth', { value: overflow ? 1200 : 400 });
  Object.defineProperty(box, 'scrollHeight', { value: overflow ? 900 : 300 });
  return box;
}

const press = { button: 0, pointerId: 1, pointerType: 'mouse' };

describe('FIX6 item 5: dragging a zoomed picture moves it', () => {
  it('scrolls the box by the drag when the picture is larger than the box', () => {
    render(<Box enabled />);
    const box = sized(screen.getByTestId('box'), true);
    box.scrollLeft = 100;
    box.scrollTop = 50;
    fireEvent.pointerDown(box, { ...press, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(box, { ...press, clientX: 150, clientY: 170 });
    expect(box.scrollLeft).toBe(150);
    expect(box.scrollTop).toBe(80);
    expect(box.dataset['panning']).toBe('true');
    fireEvent.pointerUp(box, press);
    expect(box.dataset['panning']).toBeUndefined();
  });

  it('does nothing when the picture fits, with another tool, or from a pin', () => {
    const { unmount } = render(<Box enabled />);
    const fits = sized(screen.getByTestId('box'), false);
    fireEvent.pointerDown(fits, { ...press, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(fits, { ...press, clientX: 100, clientY: 100 });
    expect(fits.scrollLeft).toBe(0);
    unmount();

    const other = render(<Box enabled={false} />);
    const off = sized(screen.getByTestId('box'), true);
    fireEvent.pointerDown(off, { ...press, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(off, { ...press, clientX: 100, clientY: 100 });
    expect(off.scrollLeft).toBe(0);
    other.unmount();

    render(<Box enabled />);
    const box = sized(screen.getByTestId('box'), true);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Pin' }), {
      ...press,
      clientX: 200,
      clientY: 200,
    });
    fireEvent.pointerMove(box, { ...press, clientX: 100, clientY: 100 });
    expect(box.scrollLeft).toBe(0);
  });
});
