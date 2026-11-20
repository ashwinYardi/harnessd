// Authored icons: 16 px grid, 1.5 px stroke, round caps. Decorative; labels carry meaning.
import type { ReactNode } from "react";

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
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

export const PauseIcon = () => (
  <Svg>
    <path d="M5.5 3.5v9M10.5 3.5v9" />
  </Svg>
);

export const PlayIcon = () => (
  <Svg>
    <path d="M5 3.5v9l7-4.5z" />
  </Svg>
);

export const SunIcon = () => (
  <Svg>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" />
  </Svg>
);

export const MoonIcon = () => (
  <Svg>
    <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />
  </Svg>
);

export const SystemIcon = () => (
  <Svg>
    <rect x="2" y="3" width="12" height="8.5" rx="1.25" />
    <path d="M5.5 14h5M8 11.5V14" />
  </Svg>
);

export const ArrowDownIcon = () => (
  <Svg>
    <path d="M8 3v10M4 9l4 4 4-4" />
  </Svg>
);
