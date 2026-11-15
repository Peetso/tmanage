'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useEsignT } from './esign-copy';

/** The drawn mark is exported at this size: small enough for the API's 200 KB cap. */
export const PAD_WIDTH = 600;
export const PAD_HEIGHT = 200;

export interface SignaturePadProps {
  /** The mark as raw base64 PNG (no `data:` prefix), or `null` once cleared. */
  onChange: (markPng: string | null) => void;
  disabled?: boolean;
}

/**
 * 52-26 (Figma 610:34521): the draw pad. Pointer events cover finger, pen and mouse; the canvas
 * keeps a fixed 600 × 200 bitmap scaled by CSS, so coordinates are mapped, not mirrored, in RTL.
 * A keyboard user cannot draw — the hint sends them to Type, which signs just the same.
 */
export function SignaturePad({ onChange, disabled = false }: SignaturePadProps) {
  const t = useEsignT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(false);

  const context = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d') ?? null;
    if (canvas && ctx) {
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = getComputedStyle(canvas).color || '#111';
    }
    return ctx;
  }, []);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / (rect.width || PAD_WIDTH)) * PAD_WIDTH,
      y: ((event.clientY - rect.top) / (rect.height || PAD_HEIGHT)) * PAD_HEIGHT,
    };
  };

  const clear = useCallback(() => {
    const canvas = canvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, PAD_WIDTH, PAD_HEIGHT);
    inked.current = false;
    onChange(null);
  }, [onChange]);

  // A new pad starts empty: nothing from a previous mode survives.
  useEffect(() => () => onChange(null), [onChange]);

  return (
    <div className="tm-esign-pad">
      <canvas
        ref={canvasRef}
        className="tm-esign-pad__canvas"
        width={PAD_WIDTH}
        height={PAD_HEIGHT}
        role="img"
        aria-label={t('padLabel')}
        onPointerDown={(event) => {
          if (disabled) return;
          const ctx = context();
          if (!ctx) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          drawing.current = true;
          const { x, y } = point(event);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + 0.1, y + 0.1);
          ctx.stroke();
          inked.current = true;
        }}
        onPointerMove={(event) => {
          if (!drawing.current) return;
          const ctx = canvasRef.current?.getContext('2d');
          if (!ctx) return;
          const { x, y } = point(event);
          ctx.lineTo(x, y);
          ctx.stroke();
        }}
        onPointerUp={() => {
          if (!drawing.current) return;
          drawing.current = false;
          const data = inked.current ? canvasRef.current?.toDataURL('image/png') : null;
          onChange(data ? (data.split(',')[1] ?? null) : null);
        }}
        onPointerCancel={() => {
          drawing.current = false;
        }}
      />
      <div className="tm-esign-pad__foot">
        <span>{t('padHint')}</span>
        <button type="button" className="tm-esign-link" onClick={clear} disabled={disabled}>
          {t('clear')}
        </button>
      </div>
      <p className="tm-esign-muted">{t('padKeyboardHint')}</p>
    </div>
  );
}
