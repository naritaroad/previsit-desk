import { IconAdjustmentsHorizontal, IconChevronDown, IconDeviceLaptop, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconLogout, IconSearch, IconSelector, IconWifiOff, IconWorld, type Icon } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, useNavigate } from "react-router";

import type { Locale } from "@/api/types";
import { useSession, type TextSize, type ThemeChoice } from "@/app/session-context";
import { PORTAL_PATH, portalOf, type Portal } from "@/lib/permissions";
import { Avatar, CountBadge, IconButton, Kbd, Menu, MenuItem, MenuLabel, MenuLink, MenuRadioGroup, MenuSeparator, NotificationBell, Spinner, Tooltip, useLocale, useOnline, type Density } from "@/ui";

/** The mark: a ruled bag with three dispensing cells, the first one used. */
export function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="3.5" y="2.5" width="25" height="27" rx="2" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M3.5 13h25M12 13v16.5M20 13v16.5" stroke="currentColor" strokeWidth="2.5" />
      <path d="M4 13h8v16H4z" fill="currentColor" />
      <path d="M9 7.75h14" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}

export function Brand({ to, sub, compact, className }: { to: string; sub?: string; compact?: boolean; className?: string }) {
  const { t } = useTranslation("shell");
  return (
    <Link to={to} className={`brand ${className ?? ""}`} aria-label={compact ? t("brand.name") : undefined}>
      <BrandMark />
      {!compact && (
        <span>
          {t("brand.name")}
          {sub && <small>{sub}</small>}
        </span>
      )}
    </Link>
  );
}

export function SkipLink() {
  const { t } = useTranslation("shell");
  return (
    <a
      className="skip-link"
      href="#main"
      onClick={(e) => {
        e.preventDefault();
        const main = document.getElementById("main");
        main?.focus();
        main?.scrollIntoView();
      }}
    >
      {t("skip")}
    </a>
  );
}

export interface NavEntry {
  to: string;
  label: string;
  icon: Icon;
  end?: boolean;
  count?: number;
  /** Emergencies among them: a second, red count. */
  urgent?: number;
}
export interface NavGroup {
  title?: string;
  items: NavEntry[];
}

export function RailLink({ entry, collapsed, onNavigate }: { entry: NavEntry; collapsed?: boolean; onNavigate?: () => void }) {
  const { t } = useTranslation("shell");
  const link = (
    <NavLink to={entry.to} end={entry.end} className="rail-link" onClick={onNavigate} aria-label={collapsed ? entry.label : undefined}>
      <entry.icon aria-hidden />
      <span className="label truncate">{entry.label}</span>
      {entry.urgent ? <CountBadge count={entry.urgent} tone="danger" label={t("nav.urgent", { count: entry.urgent })} /> : null}
      {entry.count && !(collapsed && entry.urgent) ? <CountBadge count={entry.count} label={t("nav.count", { count: entry.count })} /> : null}
    </NavLink>
  );
  return collapsed ? (
    <Tooltip content={entry.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

export function RailNav({ groups, collapsed, label, onNavigate, children }: { groups: NavGroup[]; collapsed?: boolean; label: string; onNavigate?: () => void; children?: ReactNode }) {
  return (
    <nav className="rail-nav" aria-label={label}>
      {groups.map((g, i) => (
        <div key={g.title ?? i}>
          {g.title && <p className="rail-group">{g.title}</p>}
          <ul>
            {g.items.map((e) => (
              <li key={e.to}>
                <RailLink entry={e} collapsed={collapsed} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      {children}
    </nav>
  );
}

export function CollapseButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { t } = useTranslation("shell");
  return (
    <IconButton label={collapsed ? t("nav.expand") : t("nav.collapse")} size="sm" className="ms-auto" onClick={onToggle} aria-expanded={!collapsed} tooltipSide="right">
      {collapsed ? <IconLayoutSidebarLeftExpand size={20} aria-hidden /> : <IconLayoutSidebarLeftCollapse size={20} aria-hidden />}
    </IconButton>
  );
}

/** Language, theme and text size: in the account menu everywhere, and alone on the public site. */
export function DisplayMenuItems() {
  const { t } = useTranslation("shell");
  const { prefs, setPrefs, setLocale } = useSession();
  const locale = useLocale();
  return (
    <>
      <MenuRadioGroup
        label={t("menu.language")}
        value={locale}
        onValueChange={(v) => setLocale(v as Locale)}
        options={[
          { value: "zh-TW", label: t("menu.zh") },
          { value: "en", label: t("menu.en") },
        ]}
      />
      <MenuSeparator />
      <MenuRadioGroup
        label={t("menu.theme")}
        value={prefs.theme}
        onValueChange={(v) => setPrefs({ theme: v as ThemeChoice })}
        options={(["system", "light", "dark"] as const).map((v) => ({ value: v, label: t(`menu.theme_${v}`) }))}
      />
      <MenuSeparator />
      <MenuRadioGroup
        label={t("menu.text")}
        value={prefs.text}
        onValueChange={(v) => setPrefs({ text: v as TextSize })}
        options={(["100", "112", "125"] as const).map((v) => ({ value: v, label: t(`menu.text_${v}`) }))}
      />
    </>
  );
}

/** Public header: the display settings without an account. */
export function DisplayMenu({ className }: { className?: string }) {
  const { t } = useTranslation("shell");
  return (
    <Menu
      trigger={
        <button type="button" className={`icon-btn ${className ?? ""}`} aria-label={t("menu.display")}>
          <IconAdjustmentsHorizontal size={22} aria-hidden />
        </button>
      }
    >
      <DisplayMenuItems />
    </Menu>
  );
}

export function AccountMenu({ collapsed, settingsTo, side = "top", variant = "rail", density }: { collapsed?: boolean; settingsTo: string; side?: "top" | "bottom"; variant?: "rail" | "icon"; /** Staff workspaces: row and control size. */ density?: { value: Density; set: (d: Density) => void } }) {
  const { t } = useTranslation("shell");
  const { me, signOut } = useSession();
  const navigate = useNavigate();
  if (!me) return null;
  const role = me.title ?? t(`role.${me.role}`);
  return (
    <Menu
      side={side}
      align={variant === "icon" ? "end" : "start"}
      className="max-h-[80dvh] w-72 overflow-y-auto"
      trigger={
        variant === "icon" ? (
          <button type="button" className="icon-btn" aria-label={t("menu.account", { name: me.display_name })}>
            <Avatar name={me.display_name} size={32} />
          </button>
        ) : (
          <button type="button" className="rail-account" aria-label={collapsed ? t("menu.account", { name: me.display_name }) : undefined}>
            <Avatar name={me.display_name} size={36} />
            {!collapsed && <span className="sr-only">{t("menu.accountShort")}</span>}
            {!collapsed && (
              <span className="leading-snug">
                <span className="block truncate font-semibold">{me.display_name}</span>
                <span className="block truncate text-sm text-fg-2">{me.is_guest ? t("role.guest") : role}</span>
              </span>
            )}
            {!collapsed && <IconSelector size={18} className="flex-none" aria-hidden />}
          </button>
        )
      }
    >
      <MenuLabel>
        <span className="block font-semibold text-fg">{me.display_name}</span>
        {me.is_guest ? t("role.guest") : role}
      </MenuLabel>
      <MenuSeparator />
      <DisplayMenuItems />
      {density && (
        <>
          <MenuSeparator />
          <MenuRadioGroup label={t("menu.density")} value={density.value} onValueChange={(v) => density.set(v as Density)} options={(["compact", "comfortable"] as const).map((v) => ({ value: v, label: t(`menu.density_${v}`) }))} />
        </>
      )}
      <MenuSeparator />
      <MenuLink icon={<IconDeviceLaptop aria-hidden />} render={(p) => <Link to={settingsTo} {...p} />}>
        {t("menu.sessions")}
      </MenuLink>
      <MenuLink icon={<IconWorld aria-hidden />} render={(p) => <Link to="/" {...p} />}>
        {t("menu.public")}
      </MenuLink>
      <MenuItem icon={<IconLogout aria-hidden />} onSelect={() => void signOut().then(() => navigate("/"))}>
        {me.is_guest ? t("menu.leaveGuest") : t("menu.signOut")}
      </MenuItem>
    </Menu>
  );
}

/** Only drawn for people who can enter more than one workspace. */
export function WorkspaceSwitcher({ portals, current }: { portals: Portal[]; current: Portal }) {
  const { t } = useTranslation("shell");
  if (portals.length < 2) return null;
  return (
    <Menu
      align="start"
      trigger={
        <button type="button" className="rail-link">
          <span className="label">{t(`ws.${current}`)}</span>
          <IconChevronDown aria-hidden />
        </button>
      }
    >
      <MenuLabel>{t("menu.switchWorkspace")}</MenuLabel>
      {portals.map((p) => (
        <MenuLink key={p} render={(props) => <Link to={PORTAL_PATH[p]} aria-current={p === current ? "true" : undefined} {...props} />}>
          {t(`ws.${p}`)}
        </MenuLink>
      ))}
    </Menu>
  );
}

/** Roles map to one workspace each today (contract §1); this is the single place that would change. */
export function usePortals(): Portal[] {
  const { me } = useSession();
  return me ? [portalOf(me.role)] : [];
}

export function CommandTrigger({ onOpen, label }: { onOpen: () => void; label?: string }) {
  const { t } = useTranslation("shell");
  const mac = typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);
  return (
    <button type="button" className="cmd-trigger" onClick={onOpen} aria-keyshortcuts="Control+K Meta+K">
      <IconSearch size={18} aria-hidden />
      <span>{label ?? t("command.open")}</span>
      <span className="kbd-wrap" aria-hidden="true">
        <Kbd>{mac ? "⌘K" : "Ctrl K"}</Kbd>
      </span>
    </button>
  );
}

export function ShellBell({ allHref, className }: { allHref: string; className?: string }) {
  const { notifications, unread, markRead } = useSession();
  return <NotificationBell items={notifications} unread={unread} allHref={allHref} onReadAll={() => markRead()} onOpenItem={(n) => n.read_at === null && markRead([n.id])} className={className} />;
}

export function OfflineStrip() {
  const { t } = useTranslation("shell");
  const online = useOnline();
  if (online) return null;
  return (
    <p className="offline-strip no-print" role="status">
      <IconWifiOff size={18} aria-hidden />
      {t("offline")}
    </p>
  );
}

/** While a page's copy or code arrives inside a shell. */
export function PageLoading() {
  return (
    <div className="grid min-h-64 place-items-center">
      <Spinner />
    </div>
  );
}
