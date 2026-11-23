import type { ReactNode } from 'react';

/**
 * The 16 px line icons the Work area v2 screens draw (Figma section `919:91443`: chevron, forward,
 * plus, info, play, calendar, folder, eye, drag handle, more, pencil, close, search, check, lock,
 * file). Stroke is `currentColor`, so the control's text colour paints them; every one is
 * decorative (`aria-hidden`): the control around it carries the name. Forward and back mirror in
 * Arabic through `.tm-wk-icon--flip` (logical direction, UX RTL rule).
 */
function Svg({
  children,
  flip = false,
}: {
  readonly children: ReactNode;
  readonly flip?: boolean;
}) {
  return (
    <svg
      className={flip ? 'tm-wk-icon tm-wk-icon--flip' : 'tm-wk-icon'}
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

export const ChevronDownIcon = () => (
  <Svg>
    <path d="M4 6l4 4 4-4" />
  </Svg>
);
export const ForwardIcon = () => (
  <Svg flip>
    <path d="M6 4l4 4-4 4" />
  </Svg>
);
export const PlusIcon = () => (
  <Svg>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const InfoIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.2v3.6M8 5.2v.1" />
  </Svg>
);
export const PlayIcon = () => (
  <Svg flip>
    <path d="M5 3.5v9l7-4.5z" />
  </Svg>
);
export const CalendarIcon = () => (
  <Svg>
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
    <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
  </Svg>
);
export const FolderIcon = () => (
  <Svg>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </Svg>
);
export const EyeIcon = () => (
  <Svg>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
);
export const DragIcon = () => (
  <Svg>
    <path d="M6 3.5v.1M10 3.5v.1M6 8v.1M10 8v.1M6 12.5v.1M10 12.5v.1" strokeWidth="2" />
  </Svg>
);
export const MoreIcon = () => (
  <Svg>
    <path d="M3.5 8v.1M8 8v.1M12.5 8v.1" strokeWidth="2" />
  </Svg>
);
export const PencilIcon = () => (
  <Svg>
    <path d="M10.5 2.5l3 3-8 8H2.5v-3z" />
  </Svg>
);
export const CloseIcon = () => (
  <Svg>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const SearchIcon = () => (
  <Svg>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </Svg>
);
export const CheckIcon = () => (
  <Svg>
    <path d="M3.5 8.5l3 3 6-7" />
  </Svg>
);
export const LockIcon = () => (
  <Svg>
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </Svg>
);
export const FileIcon = () => (
  <Svg>
    <path d="M4 1.5h5l3 3v10H4z" />
    <path d="M9 1.5v3h3" />
  </Svg>
);
export const ArrowUpIcon = () => (
  <Svg>
    <path d="M8 13V3M4 7l4-4 4 4" />
  </Svg>
);
export const ArrowDownIcon = () => (
  <Svg>
    <path d="M8 3v10M4 9l4 4 4-4" />
  </Svg>
);
