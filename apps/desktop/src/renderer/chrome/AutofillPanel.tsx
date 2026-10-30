import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { accountDetails, LABEL_SEPARATOR, loginDomainOf, splitAccounts, type CredentialMatch } from "../../shared/credentials";
import type { AutofillBarState, AutofillCode } from "../../shared/credentials-ipc";
import { formatTotpCode } from "../../shared/totp";
import { chromeApi } from "../common/api";
import { t } from "../common/i18n";
import { IconChevronDown, IconChevronRight, IconClock, IconLock } from "../common/icons";

/** Space kept between the panel and the window's edges. */
const EDGE_GAP = 8;

/** The page's live 2FA codes by account id while the page has a code field, refreshed as they expire. */
function useCodes(active: boolean): Map<string, string> {
  const api = chromeApi();
  const [codes, setCodes] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!active) {
      setCodes(new Map());
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (): void => {
      void api.call("autofill.codes").then((list: AutofillCode[]) => {
        if (!alive) return;
        setCodes(new Map(list.map((c) => [c.id, c.code])));
        const next = Math.min(...list.map((c) => c.expiresAt));
        if (Number.isFinite(next)) timer = setTimeout(load, Math.max(250, next - Date.now() + 100));
      });
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, active]);
  return codes;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

interface AutofillPanelProps {
  autofill: AutofillBarState;
  matches: CredentialMatch[];
  /** The page's address: its domain names the section of the other hosts' accounts. */
  url: string;
  /** Called after an action closed the panel. */
  onDone: () => void;
}

/**
 * The omnibox key panel: one row per account of the page (username, then its site), the page's own
 * host first and the domain's other hosts folded away. A row fills the account (login, and the code
 * when the page asks for one); an account with a 2FA has its own button, which fills the live code
 * shown on it when the page has a code field and copies it otherwise.
 */
export function AutofillPanel({ autofill, matches, url, onDone }: AutofillPanelProps) {
  const api = chromeApi();
  const [othersOpen, setOthersOpen] = useState(false);
  const codes = useCodes(autofill.otpAvailable);
  const panel = useRef<HTMLDivElement>(null);
  const listed = autofill.matchCount > 0 ? matches : autofill.otpAvailable ? matches.filter((m) => m.hasTotp) : [];
  const { first, others } = splitAccounts(listed);
  const domain = loginDomainOf(hostOf(url));

  // Anchored under the key button at the right: never past the window's left edge, also on resize.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const fit = (): void => {
      el.style.removeProperty("transform");
      const left = el.getBoundingClientRect().left;
      if (left < EDGE_GAP) el.style.transform = `translateX(${EDGE_GAP - left}px)`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  });

  const act = (method: "autofill.fill" | "autofill.fillTotp" | "autofill.copyTotp", id: string): void => {
    void api.call(method, id);
    onDone();
  };

  const row = (m: CredentialMatch) => {
    const user = m.username || t("(no username)");
    const details = accountDetails(m, t("2FA only")).join(LABEL_SEPARATOR);
    const code = codes.get(m.id);
    return (
      <div className="af-row" key={m.id}>
        <button className="af-fill" title={details ? `${user}\n${details}` : user} onMouseDown={(e) => { e.preventDefault(); act("autofill.fill", m.id); }}>
          <span className="af-icon">{m.hasPassword ? <IconLock size={14} /> : <IconClock size={14} />}</span>
          <span className="af-text">
            <span className="af-user">{user}</span>
            {details && <span className="af-site">{details}</span>}
          </span>
        </button>
        {m.hasTotp &&
          (autofill.otpAvailable ? (
            <button className="af-code" title={t("Fill 2FA code")} onMouseDown={(e) => { e.preventDefault(); act("autofill.fillTotp", m.id); }}>
              <span className="af-code-label">{t("Fill 2FA code")}</span>
              <span className="af-code-num">{code ? formatTotpCode(code) : "••• •••"}</span>
            </button>
          ) : (
            <button className="af-code copy" title={t("Copy 2FA code")} onMouseDown={(e) => { e.preventDefault(); act("autofill.copyTotp", m.id); }}>
              <IconClock size={13} />
              <span className="af-code-label">{t("2FA code")}</span>
            </button>
          ))}
      </div>
    );
  };

  return (
    <div className="omni-autofill-panel af-accounts" ref={panel}>
      <div className="af-list">
        {listed.length === 0 ? (
          <div className="af-empty">{t("No saved logins for this site.")}</div>
        ) : (
          <>
            {first.map(row)}
            {others.length > 0 && (
              <>
                <button className="af-others" aria-expanded={othersOpen} onMouseDown={(e) => e.preventDefault()} onClick={() => setOthersOpen((open) => !open)}>
                  {othersOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                  <span className="af-others-title">{t("Other {domain} accounts", { domain })}</span>
                  <span className="af-count">{others.length}</span>
                </button>
                {othersOpen && <div className="af-others-list">{others.map(row)}</div>}
              </>
            )}
          </>
        )}
      </div>
      <button className="af-manage" onMouseDown={(e) => { e.preventDefault(); void api.call("autofill.openManager"); onDone(); }}>
        {t("Manage passwords")}
      </button>
    </div>
  );
}
