import type { ReactNode } from 'react';

/**
 * The 16 px line icons the AI-employee screens draw that the Work set (`work-icons.tsx`) lacks:
 * the agent spark (Claude, ChatGPT, connectors), "@" (invite a person), pause, the bin (retire),
 * the turn arrow (change sponsor) and the waiting ring. Same drawing rules as the Work set:
 * `currentColor` stroke, decorative (`aria-hidden`), the control around it carries the name.
 */
function Svg({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      className="tm-wk-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const SparkIcon = () => (
  <Svg>
    <path d="M6.5 2.5l1.2 3.3 3.3 1.2-3.3 1.2-1.2 3.3-1.2-3.3L2 7l3.3-1.2z" />
    <path d="M12 10v3.5M10.25 11.75h3.5" />
  </Svg>
);

export const AtIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="2.5" />
    <path d="M10.5 8v1a1.75 1.75 0 0 0 3.5 0V8a6 6 0 1 0-2.4 4.8" />
  </Svg>
);

export const PauseIcon = () => (
  <Svg>
    <path d="M6 4v8M10 4v8" />
  </Svg>
);

export const BinIcon = () => (
  <Svg>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
  </Svg>
);

export const TurnIcon = () => (
  <Svg>
    <path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 2.5v2.8H9.7" />
  </Svg>
);

export const DotsIcon = () => (
  <Svg>
    <path d="M4 8h.01M8 8h.01M12 8h.01" strokeWidth="2.2" />
  </Svg>
);

/** The test step's rows: done (filled check), waiting (a turning ring), not yet (an empty ring). */
export function TestMark({ state }: { readonly state: 'done' | 'waiting' | 'todo' }) {
  return (
    <span className="tm-aie-test__mark" data-state={state} aria-hidden="true">
      {state === 'done' ? (
        <svg viewBox="0 0 20 20" width="20" height="20" focusable="false">
          <circle cx="10" cy="10" r="9" fill="currentColor" />
          <path
            d="M6 10.2l2.6 2.6L14 7.4"
            fill="none"
            className="tm-aie-test__tick"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" width="20" height="20" focusable="false">
          <circle
            cx="10"
            cy="10"
            r="8.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            {...(state === 'waiting' ? { strokeDasharray: '38 14' } : {})}
          />
        </svg>
      )}
    </span>
  );
}
