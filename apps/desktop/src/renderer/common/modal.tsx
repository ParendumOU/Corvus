import { useEffect, useRef, type ReactNode } from "react";
import "./modal.css";

/**
 * A modal card for Corvus's pages, with the same look as the browser's own dialogs
 * (renderer/chrome/Dialogs.tsx): Escape and the backdrop close it; focus starts inside.
 */
export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode; wide?: boolean }) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = card.current?.querySelector<HTMLElement>("input, select, button, textarea");
    first?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-layer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={card} className={`modal-card ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="modal-title">{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">{footer}</div>
      </div>
    </div>
  );
}
