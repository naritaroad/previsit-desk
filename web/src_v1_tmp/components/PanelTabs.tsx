// Two ways to move between the panes of the patient page: tabs beside the chat on wide screens and
// a bottom tab bar on narrow ones. CSS decides which one is visible (container width, 900px).
// Both are tablists with roving tabindex: arrow keys move, Home and End jump.

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "./Icon.tsx";

export type PanelKey = "trace" | "summary" | "refill";
export type PaneKey = "chat" | PanelKey;

function useRoving(keys: readonly string[], current: string, select: (k: string) => void) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKeyDown = (e: KeyboardEvent) => {
    const i = keys.indexOf(current);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % keys.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i + keys.length - 1) % keys.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = keys.length - 1;
    if (next === -1) return;
    e.preventDefault();
    select(keys[next]);
    refs.current[keys[next]]?.focus();
  };
  return { refs, onKeyDown };
}

const PANEL_KEYS: readonly PanelKey[] = ["trace", "summary", "refill"];

export function PanelTabs({ panel, onSelect, traceCount }: { panel: PanelKey; onSelect: (k: PanelKey) => void; traceCount: number }) {
  const { t } = useTranslation();
  const { refs, onKeyDown } = useRoving(PANEL_KEYS, panel, (k) => onSelect(k as PanelKey));
  const label = (k: PanelKey): ReactNode =>
    k === "trace" ? (
      <>
        {t("panel.trace")}
        {traceCount > 0 ? <span className="count-badge">{traceCount}</span> : null}
      </>
    ) : (
      t(`panel.${k}`)
    );
  return (
    <div className="panel-tabs" role="tablist" aria-label={t("panel.label")} onKeyDown={onKeyDown}>
      {PANEL_KEYS.map((k) => (
        <button
          key={k}
          ref={(el) => {
            refs.current[k] = el;
          }}
          id={`ptab-${k}`}
          className="tab"
          role="tab"
          type="button"
          aria-selected={panel === k}
          aria-controls={`pane-${k}`}
          tabIndex={panel === k ? 0 : -1}
          onClick={() => onSelect(k)}
        >
          {label(k)}
        </button>
      ))}
    </div>
  );
}

const BAR: readonly { key: PaneKey; icon: IconName }[] = [
  { key: "chat", icon: "chat" },
  { key: "trace", icon: "list" },
  { key: "summary", icon: "doc" },
  { key: "refill", icon: "pill" },
];

export function MobileTabBar({ active, onSelect, alert }: { active: PaneKey; onSelect: (k: PaneKey) => void; alert: boolean }) {
  const { t } = useTranslation();
  const { refs, onKeyDown } = useRoving(
    BAR.map((b) => b.key),
    active,
    (k) => onSelect(k as PaneKey),
  );
  return (
    <nav className="tabbar" role="tablist" aria-label={t("panel.barLabel")} onKeyDown={onKeyDown}>
      {BAR.map((b) => (
        <button
          key={b.key}
          ref={(el) => {
            refs.current[b.key] = el;
          }}
          id={`btab-${b.key}`}
          className="tabbar__btn"
          role="tab"
          type="button"
          aria-selected={active === b.key}
          aria-controls={b.key === "chat" ? "pane-chat" : `pane-${b.key}`}
          tabIndex={active === b.key ? 0 : -1}
          onClick={() => onSelect(b.key)}
        >
          <Icon name={b.icon} />
          <span>{t(`panel.bar.${b.key}`)}</span>
          {b.key === "trace" && alert ? <span className="tabbar__dot" aria-hidden="true" /> : null}
        </button>
      ))}
    </nav>
  );
}
