import type { ReactNode, SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const GlyphSummary = (p: P) => (
  <Svg {...p}>
    <path d="M4 6h16M4 11h11M4 16h7" />
    <path d="M17.5 14.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill="currentColor" stroke="none" />
  </Svg>
);
export const GlyphTranslate = (p: P) => (
  <Svg {...p}>
    <path d="M4 5h9M8.5 3v2M6 5c.6 3 2.6 5.5 5.5 7M11 5c-.8 3.6-3.3 6.4-7 8" />
    <path d="M13 21l3.8-9h.4L21 21M14.3 18h5.4" />
  </Svg>
);
export const GlyphSend = (p: P) => (
  <Svg {...p}>
    <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
  </Svg>
);
export const GlyphStop = (p: P) => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
  </Svg>
);
export const GlyphUndo = (p: P) => (
  <Svg {...p}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);
export const GlyphPause = (p: P) => (
  <Svg {...p}>
    <rect x="6.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);
export const GlyphPlay = (p: P) => (
  <Svg {...p}>
    <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />
  </Svg>
);
export const GlyphClose = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const GlyphBroom = (p: P) => (
  <Svg {...p}>
    <path d="M14 4l6 6M4 20l7.5-7.5M9.5 10.5l4 4-2 5.5-7.5-7.5z" />
  </Svg>
);
export const GlyphPlug = (p: P) => (
  <Svg {...p}>
    <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />
  </Svg>
);

/** The Assist mark: a feather quill crossing a spark, drawn with the iridescent sheen. */
export function AssistMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="assist-sheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7a5cff" />
          <stop offset="0.55" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#14b8a6" />
        </linearGradient>
      </defs>
      <path d="M26 4C15 5 8 12 6.5 25.5c4-6 8.5-9.6 13.5-11-3.6 2.7-6.3 5.8-8.3 9.6C21 21 25.5 14 26 4z" fill="url(#assist-sheen)" />
      <path d="M8 4.5l.9 2.3 2.3.9-2.3.9L8 10.9l-.9-2.3-2.3-.9 2.3-.9z" fill="url(#assist-sheen)" />
    </svg>
  );
}
