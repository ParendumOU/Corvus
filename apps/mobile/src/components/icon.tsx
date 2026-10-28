/**
 * Corvus's icons: the stroke icons of the desktop app (apps/desktop/src/renderer/common/icons.tsx),
 * drawn the same way (24-unit box, 2-unit round stroke), plus a few the phone needs. And the
 * Corvus mark, the crow in the "C" of the app icon.
 */
import { Fragment } from 'react';
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

type Shape = { d: string; fill?: boolean } | { circle: [number, number, number]; fill?: boolean } | { rect: [number, number, number, number, number] };

const ICONS = {
  home: [{ d: 'M3 10.5 12 3l9 7.5' }, { d: 'M5 9v11h5v-6h4v6h5V9' }],
  bookmark: [{ d: 'M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z' }],
  settings: [
    { circle: [12, 12, 3] },
    {
      d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    },
  ],
  search: [{ circle: [11, 11, 7] }, { d: 'm20 20-3.5-3.5' }],
  close: [{ d: 'M18 6 6 18M6 6l12 12' }],
  plus: [{ d: 'M12 5v14M5 12h14' }],
  back: [{ d: 'M19 12H5M12 19l-7-7 7-7' }],
  chevronRight: [{ d: 'm9 18 6-6-6-6' }],
  chevronDown: [{ d: 'm6 9 6 6 6-6' }],
  chevronUp: [{ d: 'm6 15 6-6 6 6' }],
  star: [{ d: 'm12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z' }],
  folder: [{ d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }],
  book: [{ d: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z' }, { d: 'M4 19a2 2 0 0 1 2-2h13' }],
  history: [{ d: 'M3 12a9 9 0 1 0 3-6.7L3 8' }, { d: 'M3 3v5h5M12 7v5l3 3' }],
  sparkle: [{ d: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z' }, { d: 'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z' }],
  send: [{ d: 'M21 3 10 14' }, { d: 'M21 3l-6.5 18-4.5-7-7-4.5z' }],
  screen: [{ rect: [3, 4, 18, 12, 2] }, { d: 'M8 20h8M12 16v4' }],
  laptop: [{ d: 'M5 16V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v9' }, { d: 'M2.5 19.5 4 16h16l1.5 3.5z' }],
  phone: [{ rect: [6, 2.5, 12, 19, 2.5] }, { d: 'M11 18.5h2' }],
  eye: [{ d: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z' }, { circle: [12, 12, 3] }],
  bell: [{ d: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4z' }, { d: 'M10 21h4' }],
  check: [{ d: 'M5 12.5l4.5 4.5L19 7.5' }],
  checkCircle: [{ circle: [12, 12, 9] }, { d: 'm8 12.3 2.8 2.7L16.2 9.5' }],
  circle: [{ circle: [12, 12, 9] }],
  trash: [{ d: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14' }],
  external: [{ d: 'M14 4h6v6M10 14 20 4' }, { d: 'M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5' }],
  camera: [{ rect: [3, 6, 13, 12, 2] }, { d: 'm16 10 5-3v10l-5-3' }],
  scan: [{ d: 'M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3' }, { d: 'M7 12h10' }],
  keyboard: [{ rect: [2, 6, 20, 12, 2] }, { d: 'M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10' }],
  warning: [{ d: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' }, { d: 'M12 9v4M12 17h.01' }],
  info: [{ circle: [12, 12, 9] }, { d: 'M12 16v-4.5M12 8h.01' }],
  shield: [{ d: 'M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z' }],
  lock: [{ rect: [5, 11, 14, 10, 2] }, { d: 'M8 11V7a4 4 0 0 1 8 0v4' }],
  globe: [{ circle: [12, 12, 9] }, { d: 'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18' }],
  link: [{ d: 'M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1' }, { d: 'M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1' }],
  pin: [{ d: 'M12 17v5M9 3h6l-1 6 4 4v2H6v-2l4-4z' }],
  refresh: [{ d: 'M21 12a9 9 0 1 1-2.64-6.36' }, { d: 'M21 3v6h-6' }],
  clock: [{ circle: [12, 12, 9] }, { d: 'M12 7v5l3 2' }],
  unlink: [{ d: 'M9.5 6.5l1-1a4.5 4.5 0 0 1 6.4 6.4l-1 1M14.5 17.5l-1 1a4.5 4.5 0 0 1-6.4-6.4l1-1' }, { d: 'M4 4l16 16' }],
  more: [{ circle: [12, 5, 1], fill: true }, { circle: [12, 12, 1], fill: true }, { circle: [12, 19, 1], fill: true }],
  download: [{ d: 'M12 4v11M7 10l5 5 5-5M5 20h14' }],
  // The browser's.
  forward: [{ d: 'M5 12h14M12 5l7 7-7 7' }],
  share: [{ circle: [18, 5, 3] }, { circle: [6, 12, 3] }, { circle: [18, 19, 3] }, { d: 'M8.6 13.5l6.8 4M15.4 6.5l-6.8 4' }],
  tabs: [{ rect: [4, 4, 16, 16, 3] }],
  starFilled: [{ d: 'm12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z', fill: true }],
  shieldCheck: [{ d: 'M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z' }, { d: 'm9 12 2 2 4-4' }],
  shieldOff: [{ d: 'M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z' }, { d: 'M4 4l16 16' }],
  monitor: [{ rect: [2, 4, 20, 13, 2] }, { d: 'M8 21h8M12 17v4' }],
  stop: [{ d: 'M18 6 6 18M6 6l12 12' }],
  unlock: [{ rect: [5, 11, 14, 10, 2] }, { d: 'M8 11V7a4 4 0 0 1 7.5-2' }],
  trashAll: [{ d: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14' }, { d: 'M10 11v6M14 11v6' }],
  cookie: [{ d: 'M12 3a9 9 0 1 0 9 9 3.5 3.5 0 0 1-4.5-4.5A3.5 3.5 0 0 1 12 3z' }, { circle: [8.5, 10, 1], fill: true }, { circle: [14.5, 15, 1], fill: true }, { circle: [9, 15.5, 1], fill: true }],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 24, color, strokeWidth = 2 }: { name: IconName; size?: number; color: string; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none">
      {(ICONS[name] as Shape[]).map((shape, i) => (
        <Fragment key={i}>
          {'d' in shape && <Path d={shape.d} fill={shape.fill ? color : 'none'} />}
          {'circle' in shape && <Circle cx={shape.circle[0]} cy={shape.circle[1]} r={shape.circle[2]} fill={shape.fill ? color : 'none'} />}
          {'rect' in shape && <Rect x={shape.rect[0]} y={shape.rect[1]} width={shape.rect[2]} height={shape.rect[3]} rx={shape.rect[4]} />}
        </Fragment>
      ))}
    </Svg>
  );
}

/** The Corvus mark: the crow head inside a "C", with the app icon's gradient. */
export function CorvusMark({ size = 32 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" pointerEvents="none">
      <Defs>
        <LinearGradient id="corvus-mark" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#a3a4ff" />
          <Stop offset="1" stopColor="#5b4df0" />
        </LinearGradient>
      </Defs>
      <Path d="M52 16A26 26 0 1 0 52 48" fill="none" stroke="url(#corvus-mark)" strokeWidth={9} strokeLinecap="round" />
      <Path d="M26 24c6-5 15-5 20 1l10 3-9 3c-1 7-7 12-14 12-4 0-7-1-9-4 5 0 8-3 8-7-4 1-8-2-6-8z" fill="url(#corvus-mark)" />
      <Circle cx={37} cy={27} r={2.2} fill="#ffffff" />
    </Svg>
  );
}
