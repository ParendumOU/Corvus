import { useRef, type MouseEvent } from "react";

/**
 * Row hover for keyboard-driven lists (command bar, omnibox suggestions): the row under the pointer
 * becomes selected only when the pointer really moves. A list that opens or re-renders under a
 * resting pointer keeps its keyboard selection, so Enter runs what the person typed or picked.
 */
export function useHoverSelect(select: (index: number) => void): (index: number) => (e: MouseEvent) => void {
  const last = useRef<string | null>(null);
  return (index) => (e) => {
    const at = `${e.screenX},${e.screenY}`;
    if (last.current === null || last.current === at) {
      last.current = at;
      return;
    }
    last.current = at;
    select(index);
  };
}
