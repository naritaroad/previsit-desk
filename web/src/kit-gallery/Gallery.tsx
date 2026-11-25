import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, Route, Routes } from "react-router";

import { SessionContext, useSession, type Session } from "@/app/session-context";
import type { Me } from "@/api/types";
import { Segmented, WorkspaceContext, type Density, type Workspace } from "@/ui";

import { me, notifications, W } from "./fixtures";
import * as S from "./scenes";
import { Sections } from "./Sections";

/** Renders a shell with a made-up session. */
function As({ who, children }: { who: Me | null; children: ReactNode }) {
  const real = useSession();
  const fake: Session = { ...real, status: who ? "authenticated" : "anonymous", me: who, notifications, unread: 3, signOut: async () => {}, markRead: () => {} };
  return <SessionContext value={fake}>{children}</SessionContext>;
}

const patient = me("patient", "林秀琴");
const doctor = me("physician", "陳柏宇", "家醫科醫師");
const rph = me("pharmacist", "吳思穎", "藥師");
const admin = me("admin", "站台管理員");

const SCENES: { path: string; who: Me | null; el: ReactNode }[] = [
  { path: "public", who: null, el: <S.PublicScene /> },
  { path: "trust", who: null, el: <S.TrustScene /> },
  { path: "patient", who: patient, el: <S.PatientHomeScene /> },
  { path: "chat", who: patient, el: <S.ChatScene /> },
  { path: "wizard", who: patient, el: <S.WizardScene /> },
  { path: "clinic", who: doctor, el: <S.WorklistScene /> },
  { path: "review", who: doctor, el: <S.ReviewScene /> },
  { path: "pharmacy", who: rph, el: <S.PharmacyScene /> },
  { path: "dispense", who: rph, el: <S.DispenseScene /> },
  { path: "admin", who: admin, el: <S.AdminScene /> },
];

export default function Gallery() {
  return (
    <Routes>
      <Route index element={<Index />} />
      {SCENES.map((s) => (
        <Route key={s.path} path={`scene/${s.path}`} element={<As who={s.who}>{s.el}</As>} />
      ))}
    </Routes>
  );
}

function Index() {
  const { i18n } = useTranslation();
  const { prefs, setPrefs } = useSession();
  const [ws, setWs] = useState<Workspace>("patient");
  const [density, setDensity] = useState<Density>("comfortable");
  const opts = <T extends string>(list: readonly T[]) => list.map((v) => ({ value: v, label: v }));
  return (
    <WorkspaceContext value={{ ws, density }}>
      <div className="min-h-dvh bg-bg text-fg" data-ws={ws} data-density={density}>
        <header className="sticky top-0 z-20 border-b border-rule bg-surface">
          <div className="mx-auto flex max-w-page flex-wrap items-center gap-3 px-6 py-3">
            <p className="me-auto text-lg font-bold">{W.kit}</p>
            <Segmented label="workspace" value={ws} onValueChange={(v) => setWs(v as Workspace)} options={opts(["patient", "clinic", "pharmacy", "admin"])} />
            <Segmented label="density" value={density} onValueChange={(v) => setDensity(v as Density)} options={opts(["comfortable", "compact"])} />
            <Segmented label="theme" value={prefs.theme} onValueChange={(v) => setPrefs({ theme: v as typeof prefs.theme })} options={opts(["system", "light", "dark"])} />
            <Segmented label="text" value={prefs.text} onValueChange={(v) => setPrefs({ text: v as typeof prefs.text })} options={opts(["100", "112", "125"])} />
            <Segmented label="lang" value={i18n.language} onValueChange={(v) => void i18n.changeLanguage(v)} options={opts(["zh-TW", "en"])} />
          </div>
          <nav className="mx-auto flex max-w-page flex-wrap gap-x-5 px-6 pb-2 text-sm leading-8" aria-label={W.scenes}>
            <span className="text-fg-2">{W.scenes}</span>
            {SCENES.map((s) => (
              <Link key={s.path} to={`scene/${s.path}`} className="link">
                {s.path}
              </Link>
            ))}
          </nav>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto max-w-page px-6 py-10">
          <h1 className="sr-only">{W.kit}</h1>
          <Sections />
        </main>
      </div>
    </WorkspaceContext>
  );
}
