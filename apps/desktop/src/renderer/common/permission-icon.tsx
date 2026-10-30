import type { PermissionKind } from "../../shared/permissions";
import {
  IconActivity,
  IconApps,
  IconBell,
  IconCamera,
  IconClipboard,
  IconExpand,
  IconLocation,
  IconMic,
  IconNetwork,
  IconPiano,
  IconPointer,
  IconScreen,
} from "./icons";

export function PermissionIcon({ kind, size = 16 }: { kind: PermissionKind; size?: number }) {
  switch (kind) {
    case "camera":
      return <IconCamera size={size} />;
    case "microphone":
      return <IconMic size={size} />;
    case "geolocation":
      return <IconLocation size={size} />;
    case "notifications":
      return <IconBell size={size} />;
    case "clipboard-read":
    case "clipboard-write":
      return <IconClipboard size={size} />;
    case "midi":
    case "midi-sysex":
      return <IconPiano size={size} />;
    case "pointer-lock":
      return <IconPointer size={size} />;
    case "idle-detection":
      return <IconActivity size={size} />;
    case "display-capture":
      return <IconScreen size={size} />;
    case "fullscreen":
      return <IconExpand size={size} />;
    case "loopback-network":
      return <IconApps size={size} />;
    case "local-network":
      return <IconNetwork size={size} />;
  }
}

/** "https://a.test" -> "a.test"; other origins are shown in full so http stands out. */
export function displayOrigin(origin: string): string {
  return origin.startsWith("https://") ? origin.slice("https://".length) : origin;
}
