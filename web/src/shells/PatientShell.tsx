import { IconBell, IconCalendar, IconDots, IconHeartRateMonitor, IconHome, IconMessage2, IconMessages, IconPill, IconPlus, IconSettings, IconShieldLock } from "@tabler/icons-react";
import { Suspense, createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useLocation } from "react-router";

import { useSession } from "@/app/session-context";
import { Button, ButtonLink, CountBadge, EmergencyButton, Sheet, TextLink, WorkspaceContext, cn, usePersistentState } from "@/ui";

import { AccountMenu, Brand, CollapseButton, DisplayMenu, OfflineStrip, RailNav, ShellBell, SkipLink, type NavEntry, PageLoading } from "./parts";

/* The conversation list in the rail belongs to the visits pages, which know the data. They render it through
   <PatientRail>, and it stays mounted while the person moves between conversations. */
const RailSlot = createContext<HTMLElement | null>(null);

/** Puts content under the navigation in the side rail (desktop only). */
export function PatientRail({ children }: { children: ReactNode }) {
  const slot = useContext(RailSlot);
  return slot ? createPortal(children, slot) : null;
}

/** Pages that manage their own height (conversations, wizards) opt out of the shell's scroll area. */
const FullHeight = createContext<(on: boolean) => void>(() => {});
export function useFullHeight() {
  const set = useContext(FullHeight);
  useEffect(() => {
    set(true);
    return () => set(false);
  }, [set]);
}

/** A row of the conversation list. */
export function ConversationLink({ to, title, time, status, unread, pinned }: { to: string; title: string; time: string; status?: ReactNode; unread?: boolean; pinned?: ReactNode }) {
  const { t } = useTranslation("shell");
  return (
    <NavLink to={to} className="convo" data-unread={unread}>
      <span className="t">
        {unread && <span className="sr-only">{t("nav.unread")}</span>}
        {title}
      </span>
      {pinned ?? (unread ? <span className="unread-mark" aria-hidden="true" /> : <span />)}
      <span className="s">
        {status}
        <span className="num">{time}</span>
      </span>
    </NavLink>
  );
}

export interface PatientShellProps {
  counts?: { messages?: number; visits?: number; medications?: number };
  children?: ReactNode;
}

export function PatientShell({ counts, children }: PatientShellProps) {
  const { t } = useTranslation("shell");
  const { me, unread } = useSession();
  const [collapsed, setCollapsed] = usePersistentState("pv-rail-patient", false);
  const [more, setMore] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [full, setFull] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setMore(false), [pathname]);

  const main: NavEntry[] = [
    { to: "/app", end: true, label: t("patient.home"), icon: IconHome },
    { to: "/app/visits", label: t("patient.visits"), icon: IconMessage2, count: counts?.visits },
    { to: "/app/medications", label: t("patient.medications"), icon: IconPill, count: counts?.medications },
    { to: "/app/appointments", label: t("patient.appointments"), icon: IconCalendar },
    { to: "/app/messages", label: t("patient.messages"), icon: IconMessages, count: counts?.messages },
  ];
  const own: NavEntry[] = [
    { to: "/app/profile", label: t("patient.profile"), icon: IconHeartRateMonitor },
    { to: "/app/privacy", label: t("patient.privacy"), icon: IconShieldLock },
  ];
  const groups = useMemo(() => [{ items: main }, { title: t("patient.mine"), items: own }], [main, own, t]);

  return (
    <WorkspaceContext value={{ ws: "patient", density: "comfortable" }}>
      <RailSlot value={slot}>
        <FullHeight value={setFull}>
          <div className="shell" data-kind="patient" data-ws="patient" data-density="comfortable">
            <SkipLink />
            <aside className="rail" data-collapsed={collapsed} aria-label={t("nav.main")}>
              <div className="rail-head">
                <Brand to="/app" compact={collapsed} />
                <CollapseButton collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
              </div>
              <div className="rail-hide px-3 pb-2">
                <ButtonLink to="/app/visits/new" variant="primary" block icon={<IconPlus aria-hidden />}>
                  {t("patient.start")}
                </ButtonLink>
              </div>
              <RailNav groups={groups} collapsed={collapsed} label={t("nav.main")}>
                <div ref={setSlot} className="rail-hide" />
              </RailNav>
              <div className="rail-foot">
                <div className="rail-hide mb-2 flex items-center gap-2">
                  <EmergencyButton className="flex-1 justify-center" />
                  <ShellBell allHref="/app/notifications" />
                </div>
                <AccountMenu collapsed={collapsed} settingsTo="/app/settings" />
              </div>
            </aside>
            <div className="shell-main">
              <header className="patient-top">
                <Brand to="/app" compact className="min-w-11" />
                <span className="flex-1" />
                <EmergencyButton compact />
                <ShellBell allHref="/app/notifications" />
              </header>
              <OfflineStrip />
              {me?.is_guest && <GuestStrip />}
              <main id="main" tabIndex={-1} className={cn("shell-scroll", full && "flex flex-col overflow-hidden")}>
                <Suspense fallback={<PageLoading />}>{children ?? <Outlet />}</Suspense>
              </main>
              <nav className="tabbar" aria-label={t("nav.main")}>
                {main.slice(0, 4).map((e) => (
                  <NavLink key={e.to} to={e.to} end={e.end}>
                    <e.icon aria-hidden />
                    {t(`patient.tab.${e.to.split("/")[2] ?? "home"}`)}
                    {e.count ? <CountBadge count={e.count} label={t("nav.count", { count: e.count })} /> : null}
                  </NavLink>
                ))}
                <button type="button" onClick={() => setMore(true)} aria-haspopup="dialog" aria-current={/^\/app\/(messages|profile|privacy|settings|notifications)/.test(pathname) ? "page" : undefined}>
                  <IconDots aria-hidden />
                  {t("patient.tab.more")}
                  {counts?.messages ? <CountBadge count={counts.messages} label={t("nav.count", { count: counts.messages })} /> : null}
                </button>
              </nav>
            </div>
            <Sheet open={more} onOpenChange={setMore} title={me?.display_name ?? t("patient.tab.more")}>
              <ul className="-mx-2">
                {[main[4], ...own, { to: "/app/notifications", label: t("patient.notifications"), icon: IconBell, count: unread }, { to: "/app/settings", label: t("patient.settings"), icon: IconSettings }].map((e) => (
                  <li key={e.to}>
                    <NavLink to={e.to} className="rail-link">
                      <e.icon aria-hidden />
                      <span>{e.label}</span>
                      {e.count ? <CountBadge count={e.count} label={t("nav.count", { count: e.count })} /> : null}
                    </NavLink>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-rule pt-3">
                <span>{t("menu.display")}</span>
                <DisplayMenu />
              </div>
              <SignOutRow />
            </Sheet>
          </div>
        </FullHeight>
      </RailSlot>
    </WorkspaceContext>
  );
}

function SignOutRow() {
  const { t } = useTranslation("shell");
  const { me, signOut } = useSession();
  if (!me) return null;
  return (
    <Button block className="mt-3" onClick={() => void signOut().then(() => location.assign("/"))}>
      {me.is_guest ? t("menu.leaveGuest") : t("menu.signOut")}
    </Button>
  );
}

/** A guest sandbox says so on every page and offers to keep the data. */
function GuestStrip() {
  const { t } = useTranslation("shell");
  return (
    <aside className="guest-strip no-print" aria-label={t("role.guest")}>
      <span>{t("patient.guest")}</span>
      <TextLink to="/app/settings#claim">{t("patient.claim")}</TextLink>
    </aside>
  );
}

export default PatientShell;
