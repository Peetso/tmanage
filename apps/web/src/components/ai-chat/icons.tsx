/**
 * The 16 px line icons of the TManage AI panel (Figma Icon/Comment 459:22217, Icon/Plus 167:313,
 * Icon/Close 459:22325, Icon/Layers 459:22178, Icon/Mic 732:848, Icon/Lock, Icon/Pencil, Icon/File,
 * Icon/Trash, Icon/Eye, Icon/Circle).
 * Stroke is `currentColor`, so the semantic text colour of the control paints them; all are
 * decorative (`aria-hidden`), the control carries the name.
 */
function Svg({ children }: { readonly children: React.ReactNode }) {
  return (
    <svg
      className="tm-aic-icon"
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

export const CommentIcon = () => (
  <Svg>
    <path d="M2.5 3h11v8h-6l-3 2.5V11h-2z" />
  </Svg>
);
export const PlusIcon = () => (
  <Svg>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const CloseIcon = () => (
  <Svg>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
export const LayersIcon = () => (
  <Svg>
    <path d="M8 2l6 3.2-6 3.2-6-3.2z" />
    <path d="M2 8.4l6 3.2 6-3.2" />
  </Svg>
);
export const MicIcon = () => (
  <Svg>
    <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
    <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
  </Svg>
);
export const LockIcon = () => (
  <Svg>
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </Svg>
);
export const PencilIcon = () => (
  <Svg>
    <path d="M10.5 2.5l3 3-8 8H2.5v-3z" />
  </Svg>
);
export const FileIcon = () => (
  <Svg>
    <path d="M4 1.5h5l3 3v10H4z" />
    <path d="M9 1.5v3h3" />
  </Svg>
);
export const BackIcon = () => (
  <Svg>
    <path d="M10 3L5 8l5 5" />
  </Svg>
);
export const TrashIcon = () => (
  <Svg>
    <path d="M2.5 4h11" />
    <path d="M6 4V2.5h4V4" />
    <path d="M4 4l.75 9.5h6.5L12 4" />
  </Svg>
);
/** Activity: the AI read something (Figma Icon/Eye). */
export const EyeIcon = () => (
  <Svg>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </Svg>
);
/** Activity: the AI asked and the request waits (Figma Icon/Circle). */
export const CircleIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="5" />
  </Svg>
);
