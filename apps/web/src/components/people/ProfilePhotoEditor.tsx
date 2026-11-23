'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, PointerEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Avatar, Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { browserApiClient } from '../../lib/api/browser-client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  myPhotoKey,
  peoplePhotosKey,
  PHOTO_ACCEPT,
  PHOTO_PICK_MAX_BYTES,
  PHOTO_UPLOAD_SIDE,
  photoMimeType,
  removeMyPhoto,
  uploadMyPhoto,
} from '../../lib/api/profile-photo';
import type { MyPhotoView } from '../../lib/api/profile-photo';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { MyAvatar, useMyPhoto } from './PersonAvatar';
import './profile-photo.css';

/**
 * The Profile page's photo (owner, 2026-11-23): the photo with Change and Remove, a file picker or
 * a drop, and a square crop preview (drag to place, slider or arrow keys to zoom and move) before
 * anything is sent. The browser sends the 512 px square it cut; the API checks it, scans it and
 * makes its own 256 and 64 px copies, so no EXIF or location data is kept.
 */

const VIEW = 224;
const MIN_SIDE = 64;
const MAX_ZOOM = 3;
const STEP = 8;

const k = (name: string) => `ProfilePhoto.${name}` as MessageKey;

interface Draft {
  readonly url: string;
  readonly image: HTMLImageElement;
}

interface Placement {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

/** The displayed size of the image at a zoom, so its short side covers the square. */
function displayed(image: HTMLImageElement, zoom: number) {
  const scale = (VIEW / Math.min(image.naturalWidth, image.naturalHeight)) * zoom;
  return { width: image.naturalWidth * scale, height: image.naturalHeight * scale };
}

/** Keep the image covering the square: the offset is clamped to the overhang. */
function clamp(image: HTMLImageElement, p: Placement): Placement {
  const size = displayed(image, p.zoom);
  const maxX = (size.width - VIEW) / 2;
  const maxY = (size.height - VIEW) / 2;
  return {
    zoom: p.zoom,
    x: Math.max(-maxX, Math.min(maxX, p.x)),
    y: Math.max(-maxY, Math.min(maxY, p.y)),
  };
}

/** Draw the visible square at {@link PHOTO_UPLOAD_SIDE} px and encode it as JPEG. */
async function cut(image: HTMLImageElement, p: Placement): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = PHOTO_UPLOAD_SIDE;
  canvas.height = PHOTO_UPLOAD_SIDE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas');
  const ratio = PHOTO_UPLOAD_SIDE / VIEW;
  const size = displayed(image, p.zoom);
  const left = (VIEW - size.width) / 2 + p.x;
  const top = (VIEW - size.height) / 2 + p.y;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, PHOTO_UPLOAD_SIDE, PHOTO_UPLOAD_SIDE);
  context.drawImage(image, left * ratio, top * ratio, size.width * ratio, size.height * ratio);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('encode'))),
      'image/jpeg',
      0.9,
    );
  });
}

function errorKey(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 400 || error.status === 422) return 'errorRefused';
    if (error.status === 503) return 'errorTryLater';
  }
  return 'errorGeneric';
}

export function ProfilePhotoEditor({
  organizationSlug,
  name,
  client,
}: {
  organizationSlug: string;
  name: string;
  client?: ApiClient;
}) {
  const t = useT();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const mine = useMyPhoto(organizationSlug);
  const inputRef = useRef<HTMLInputElement>(null);
  const zoomId = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [place, setPlace] = useState<Placement>({ zoom: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const drag = useRef<{ x: number; y: number; from: Placement } | null>(null);

  useEffect(() => () => (draft ? URL.revokeObjectURL(draft.url) : undefined), [draft]);

  const applied = (view: MyPhotoView) => {
    queryClient.setQueryData(myPhotoKey(organizationSlug), view);
    void queryClient.invalidateQueries({ queryKey: peoplePhotosKey(organizationSlug) });
  };

  const pick = useCallback((file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (photoMimeType(file) === null) return setError('errorType');
    if (file.size > PHOTO_PICK_MAX_BYTES) return setError('errorSize');
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (Math.min(image.naturalWidth, image.naturalHeight) < MIN_SIDE) {
        URL.revokeObjectURL(url);
        setError('errorSmall');
        return;
      }
      setPlace({ zoom: 1, x: 0, y: 0 });
      setDraft({ url, image });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      setError('errorUnreadable');
    };
    image.src = url;
  }, []);

  const move = (next: Placement) => draft && setPlace(clamp(draft.image, next));

  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const by: Record<string, [number, number]> = {
      ArrowLeft: [STEP, 0],
      ArrowRight: [-STEP, 0],
      ArrowUp: [0, STEP],
      ArrowDown: [0, -STEP],
    };
    const delta = by[event.key];
    if (delta) {
      event.preventDefault();
      move({ ...place, x: place.x + delta[0], y: place.y + delta[1] });
    } else if (event.key === '+' || event.key === '=') {
      move({ ...place, zoom: Math.min(MAX_ZOOM, place.zoom + 0.1) });
    } else if (event.key === '-') {
      move({ ...place, zoom: Math.max(1, place.zoom - 0.1) });
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, from: place };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const start = drag.current;
    if (!start) return;
    move({
      ...start.from,
      x: start.from.x + event.clientX - start.x,
      y: start.from.y + event.clientY - start.y,
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    pick(event.dataTransfer.files[0]);
  };

  const save = async () => {
    if (!draft) return;
    setBusy('save');
    setError(null);
    try {
      applied(await uploadMyPhoto(api, organizationSlug, await cut(draft.image, place)));
      setDraft(null);
    } catch (caught) {
      setError(errorKey(caught));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    setError(null);
    try {
      applied(await removeMyPhoto(api, organizationSlug));
    } catch (caught) {
      setError(errorKey(caught));
    } finally {
      setBusy(null);
    }
  };

  const hasPhoto = mine.data?.photo != null;
  const size = draft ? displayed(draft.image, place.zoom) : null;

  return (
    <section className="tm-photo" aria-label={t(k('title'))}>
      <input
        ref={inputRef}
        type="file"
        accept={PHOTO_ACCEPT}
        className="tm-photo__input"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          pick(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      {draft && size ? (
        <div className="tm-photo__crop">
          <button
            type="button"
            className="tm-photo__frame"
            aria-label={t(k('cropLabel'))}
            onKeyDown={onKey}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <img
              src={draft.url}
              alt=""
              draggable={false}
              className="tm-photo__draft"
              style={{
                inlineSize: `${size.width}px`,
                blockSize: `${size.height}px`,
                transform: `translate(calc(-50% + ${place.x}px), calc(-50% + ${place.y}px))`,
              }}
            />
          </button>
          <div className="tm-photo__controls">
            <label htmlFor={zoomId} className="tm-photo__label">
              {t(k('zoom'))}
            </label>
            <input
              id={zoomId}
              type="range"
              min={1}
              max={MAX_ZOOM}
              step={0.05}
              value={place.zoom}
              onChange={(event) => move({ ...place, zoom: Number(event.target.value) })}
            />
            <div className="tm-photo__actions">
              <Button tone="ink" loading={busy === 'save'} onClick={() => void save()}>
                {t(k('save'))}
              </Button>
              <Button tone="text" onClick={() => setDraft(null)} disabled={busy !== null}>
                {t(k('cancel'))}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div
          className="tm-photo__row"
          data-drag-over={dragOver || undefined}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {mine.data?.photo && mine.data.removedHere ? (
            <Avatar name={name} size="feature" />
          ) : (
            <MyAvatar organizationSlug={organizationSlug} name={name} size="feature" />
          )}
          <div className="tm-photo__side">
            <div className="tm-photo__actions">
              <Button tone="outline" onClick={() => inputRef.current?.click()}>
                {hasPhoto ? t(k('change')) : t(k('add'))}
              </Button>
              {hasPhoto ? (
                <Button tone="text" loading={busy === 'remove'} onClick={() => void remove()}>
                  {t(k('remove'))}
                </Button>
              ) : null}
            </div>
            <p className="tm-photo__hint">{t(k('hint'))}</p>
          </div>
        </div>
      )}
      {mine.data?.removedHere ? (
        <InlineAlert tone="warning" title={t(k('removedHereTitle'))}>
          {t(k('removedHereBody'))}
        </InlineAlert>
      ) : null}
      {error ? (
        <InlineAlert tone="danger" title={t(k(error))} live>
          {t(k('errorAgain'))}
        </InlineAlert>
      ) : null}
    </section>
  );
}
