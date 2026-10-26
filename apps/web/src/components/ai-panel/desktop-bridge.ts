/**
 * The desktop shell's AI panel bridge (apps/desktop/src/preload.ts → `window.tmanageDesktop`).
 *
 * Inside the desktop app the assistant's website is shown in a docked view the shell owns; this
 * page only draws the panel chrome and tells the shell where the website area is. The page names
 * an assistant by key — never by URL — and the shell decides which website that key may load.
 */

/** The website area in CSS pixels of this page's viewport. */
export interface PanelBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** False while something of ours (the chooser) has to show over the website area. */
  readonly visible: boolean;
}

export interface DesktopAiPanel {
  open(request: { readonly site: string; readonly bounds: PanelBounds }): Promise<boolean>;
  setBounds(bounds: PanelBounds): Promise<void>;
  popOut(): Promise<boolean>;
  close(): Promise<void>;
}

interface DesktopWindow {
  tmanageDesktop?: { aiPanel?: DesktopAiPanel };
}

/** The bridge when this page runs inside the desktop app, otherwise `null` (the website). */
export function desktopAiPanel(): DesktopAiPanel | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as DesktopWindow).tmanageDesktop?.aiPanel ?? null;
}
