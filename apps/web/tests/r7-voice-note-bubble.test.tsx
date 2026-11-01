import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VoiceNoteBubble } from '../src/components/chat/media/VoiceNoteBubble';
import type { VoiceWaveFactory } from '../src/components/chat/media/VoiceNoteBubble';

/** R7 slice 5 — the bubble draws the stored peaks, shows the length, plays and steps the speed. */
describe('VoiceNoteBubble', () => {
  it('renders fixture peaks and drives the wave', async () => {
    const wave = { playPause: vi.fn(), setPlaybackRate: vi.fn(), destroy: vi.fn() };
    let input: Parameters<VoiceWaveFactory>[0] | undefined;
    const factory: VoiceWaveFactory = async (given) => ((input = given), wave);
    const peaks = [0.1, 0.5, 1, 0.4];
    const { container } = render(
      <VoiceNoteBubble
        src="/note.m4a"
        durationMs={7_000}
        peaks={peaks}
        waveformFactory={factory}
      />,
    );
    expect(container.querySelectorAll('.r7-voice__bars span')).toHaveLength(4);
    expect(screen.getByText('0:07')).toBeTruthy();
    await act(async () => undefined);
    expect(input?.peaks).toEqual(peaks);
    fireEvent.click(screen.getByRole('button', { name: 'Play voice note' }));
    expect(wave.playPause).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Playback speed' }));
    expect(wave.setPlaybackRate).toHaveBeenCalledWith(1.5);
  });
});
