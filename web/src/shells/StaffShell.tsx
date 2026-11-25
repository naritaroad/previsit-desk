import { IconMenu2 } from "@tabler/icons-react";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation, useNavigate } from "react-router";

import { useSession } from "@/app/session-context";
import { CommandPalette, IconButton, Sheet, WorkspaceContext, cn, usePersistentState, useWorkspace, type CommandGroup, type Density, type Workspace } from "@/ui";

import { AccountMenu, Brand, CollapseButton, CommandTrigger, OfflineStrip, RailNav, ShellBell, SkipLink, WorkspaceSwitcher, usePortals, type NavGroup, PageLoading } from "./parts";

export interface StaffShellProps {
  ws: Extract<Workspace, "clinic" | "pharmacy" | "admin">;
  home: string;
  groups: NavGroup[];
  /** Between the top bar and the page: the pharmacy board, the admin system line. */
  strip?: ReactNode;
  /** Left side of the top bar. Default: the search field. */
  topStart?: ReactNode;
  children?: ReactNode;
  /** Server results for the palette (patients, requests). */
  commandGroups?: CommandGroup[];
  onCommandQuery?: (q: string) => void;
}

/** The frame the three staff workspaces share. What makes them different is in their own files and in shells.css. */
export function StaffShell({ ws, home, groups, strip, topStart, children, commandGroups = [], onCommandQuery }: StaffShellProps) {
  const { t } = useTranslation("shell");
  const { signOut, prefs, setPrefs } = useSession();
  const navigate = useNavigate();
  const portals = usePortals();
  const [collapsed, setCollapsed] = usePersistentState(`pv-rail-${ws}`, false);
  const [density, setDensity] = usePersistentState<Density>(`pv-density-${ws}`, "compact");
  const [nav, setNav] = useState(false);
  const [palette, setPalette] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setNav(false), [pathname]);
  useEffect(() => {
    document.documentElement.dataset.shell = "app";
    return () => {
      delete document.documentElement.dataset.shell;
    };
  }, []);
  const solid = ws !== "admin";

  const commands = useMemo<CommandGroup[]>(
    () => [
      ...commandGroups,
      {
        id: "go",
        title: t("command.go"),
        entries: groups.flatMap((g) => g.items.map((i) => ({ id: i.to, label: i.label, icon: <i.icon aria-hidden />, onSelect: () => void navigate(i.to) }))),
      },
      {
        id: "do",
        title: t("command.do"),
        entries: [
          { id: "rail", label: collapsed ? t("nav.expand") : t("nav.collapse"), onSelect: () => setCollapsed(!collapsed) },
          { id: "theme", label: prefs.theme === "dark" ? t("command.light") : t("command.dark"), onSelect: () => setPrefs({ theme: prefs.theme === "dark" ? "light" : "dark" }) },
          { id: "out", label: t("menu.signOut"), onSelect: () => void signOut().then(() => navigate("/")) },
        ],
      },
    ],
    [commandGroups, groups, collapsed, prefs.theme, navigate, setCollapsed, setPrefs, signOut, t],
  );

  const rail = (inSheet: boolean) => (
    <div className="rail" role={inSheet ? undefined : "complementary"} aria-label={inSheet ? undefined : t(`ws.${ws}`)} data-collapsed={!inSheet && collapsed} data-solid={solid}>
      <div className="rail-head">
        <Brand to={home} sub={t(`ws.${ws}`)} compact={!inSheet && collapsed} />
        {!inSheet && <CollapseButton collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />}
      </div>
      <div className="px-3 empty:hidden">
        <WorkspaceSwitcher portals={portals} current={ws} />
      </div>
      <RailNav groups={groups} collapsed={!inSheet && collapsed} label={t("nav.main")} onNavigate={() => setNav(false)} />
      <div className="rail-foot">
        <AccountMenu collapsed={!inSheet && collapsed} settingsTo={`${home}/settings`} density={{ value: density, set: setDensity }} />
      </div>
    </div>
  );

  return (
    <WorkspaceContext value={{ ws, density }}>
      <div className="shell" data-kind={ws} data-ws={ws} data-density={density}>
        <SkipLink />
        {rail(false)}
        <div className="shell-main">
          <header className="shell-top">
            <IconButton label={t("nav.open")} tooltip={false} className="shell-menu-btn" onClick={() => setNav(true)} aria-haspopup="dialog">
              <IconMenu2 size={22} aria-hidden />
            </IconButton>
            {topStart ?? <CommandTrigger onOpen={() => setPalette(true)} label={t(`command.search_${ws}`)} />}
            <span className="flex-1" />
            {topStart && <CommandTrigger onOpen={() => setPalette(true)} label={t(`command.search_${ws}`)} />}
            <ShellBell allHref={`${home}/notifications`} />
          </header>
          <OfflineStrip />
          {strip}
          <main id="main" tabIndex={-1} className="shell-scroll">
            <Suspense fallback={<PageLoading />}>{children ?? <Outlet />}</Suspense>
          </main>
        </div>
        <Sheet open={nav} onOpenChange={setNav} title={t("nav.main")} hideTitle side="left">
          {rail(true)}
        </Sheet>
        <CommandPalette open={palette} onOpenChange={setPalette} groups={commands} placeholder={t(`command.search_${ws}`)} onQuery={onCommandQuery} />
      </div>
    </WorkspaceContext>
  );
}

/** A page that fills the pane below the top bar and scrolls inside itself (review desk, split views). */
export function FillPage({ head, children, className }: { head?: ReactNode; children: ReactNode; className?: string }) {
  const { density } = useWorkspace();
  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)} data-density={density}>
      {head && <div className="flex-none border-b border-rule bg-surface">{head}</div>}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/** Path shown in the admin top bar. */
export function Crumbs({ items }: { items: { label: string; to?: string }[] }) {
  const { t } = useTranslation("shell");
  return (
    <nav aria-label={t("nav.path")}>
      <ol className="crumbs">
        {items.map((i, n) => (
          <li key={n}>
            {i.to && n < items.length - 1 ? (
              <Link to={i.to} className="link" data-quiet="true">
                {i.label}
              </Link>
            ) : (
              <span aria-current="page">{i.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
