import "./patient.css";

import { Outlet } from "react-router";

import { usePatientHome, useRxList, useVisits } from "@/data";
import { PatientShell } from "@/shells/PatientShell";

import { hasThread } from "./threads";
import { VisitRail } from "./visit/VisitRail";

/** The connected shell: counts for the navigation and the conversation list in the rail. */
export default function Shell() {
  const home = usePatientHome();
  const visits = useVisits({ archived: false });
  const rx = useRxList();
  const unreadThreads = visits.items.filter((v) => v.has_unread && hasThread(v)).length + rx.items.filter((r) => r.unread && r.status !== "draft").length;
  const unreadVisits = visits.items.filter((v) => v.has_unread).length;
  const due = home.data?.medications.filter((m) => m.state === "window_open" && !m.open_request_id).length;
  return (
    <PatientShell counts={{ messages: unreadThreads, visits: unreadVisits, medications: due }}>
      <VisitRail />
      <Outlet />
    </PatientShell>
  );
}
