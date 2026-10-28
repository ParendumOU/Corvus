import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../common/theme.css";
import "./pages.css";
import { t } from "../common/i18n";
import { CorvusMark, IconAgent, IconBook, IconClock, IconDownload, IconEdit, IconFolder, IconGlobe, IconHistory, IconLock, IconPointer, IconPuzzle, IconSearch, IconSettings } from "../common/icons";

export function mount(node: ReactNode): void {
  createRoot(document.getElementById("root") as HTMLElement).render(node);
}

const nav = () => [
  { id: "find", label: t("Find in my pages"), href: "corvus://find/", icon: <IconSearch size={16} /> },
  { id: "history", label: t("History"), href: "corvus://history/", icon: <IconHistory size={16} /> },
  { id: "bookmarks", label: t("Bookmarks"), href: "corvus://bookmarks/", icon: <IconFolder size={16} /> },
  { id: "reading", label: t("Reading list"), href: "corvus://reading/", icon: <IconBook size={16} /> },
  { id: "annotations", label: t("Annotations"), href: "corvus://annotations/", icon: <IconEdit size={16} /> },
  { id: "schedules", label: t("Scheduled agents"), href: "corvus://schedules/", icon: <IconClock size={16} /> },
  { id: "agent-runs", label: t("Agent runs"), href: "corvus://agent-runs/", icon: <IconAgent size={16} /> },
  { id: "site-profiles", label: t("Site AI profiles"), href: "corvus://site-profiles/", icon: <IconGlobe size={16} /> },
  { id: "flows", label: t("Workflows"), href: "corvus://flows/", icon: <IconPointer size={16} /> },
  { id: "passwords", label: t("Passwords"), href: "corvus://passwords/", icon: <IconLock size={16} /> },
  { id: "downloads", label: t("Downloads"), href: "corvus://downloads/", icon: <IconDownload size={16} /> },
  { id: "extensions", label: t("Extensions"), href: "corvus://extensions/", icon: <IconPuzzle size={16} /> },
  { id: "settings", label: t("Settings"), href: "corvus://settings/", icon: <IconSettings size={16} /> },
];

export function PageShell({
  title,
  active,
  toolbar,
  sidebar,
  children,
}: {
  title: string;
  active: string;
  toolbar?: ReactNode;
  sidebar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page">
      <header className="page-header">
        <a className="brand" href="corvus://newtab/">
          <CorvusMark size={26} />
          <span>Corvus</span>
        </a>
        <h1>{t(title)}</h1>
        <div className="page-toolbar">{toolbar}</div>
      </header>
      <div className="page-body">
        <nav className="side-nav">
          {nav().map((item) => (
            <a key={item.id} href={item.href} className={item.id === active ? "active" : ""}>
              {item.icon}
              <span>{item.label}</span>
            </a>
          ))}
          {sidebar && <div className="side-extra">{sidebar}</div>}
        </nav>
        <main className="page-main">{children}</main>
      </div>
    </div>
  );
}

export function Section({ id, title, description, children }: { id?: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="card" id={id}>
      <div className="card-head">
        <h2>{title}</h2>
        {description && <p className="muted">{description}</p>}
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

/** A setting: its label and hint, and its control on the right (or under them when it does not fit). No control: a heading for what follows it. */
export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="row">
      <div className="row-label">
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      {children !== undefined && <div className="row-control">{children}</div>}
    </div>
  );
}
