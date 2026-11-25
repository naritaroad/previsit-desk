// Clinic workspace: overview, worklist, thread, note, tickets, patients, schedule.

import type { CareStatus, ClinicalNoteSections, PatientDetail, TimelineEntry, WorkItem, WorklistBucket } from "../../api/types.ts";
import { isValidDate, taipeiDate } from "../../lib/format.ts";
import { uuid } from "../../lib/ids.ts";
import { isOpenRx } from "../../lib/rx.ts";
import { badField, checkRevision, created, DONE, fail, must, ok, page, person, personOr, type Route, route, type UserCtx } from "../core.ts";
import { type AppointmentRec, fid, type VisitRec } from "../db.ts";
import { L } from "../rules.ts";
import { addMessage, appointmentView, audit, emitVisit, logAccess, medications, messageView, noteView, notify, patientRow, previsitState, rxBrief, ticketView, todayOf, visitChanged, visitView } from "../views.ts";
import { checkMessage, physicianKeys, slotTimes, visitFor } from "./patient.ts";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const RANK = { urgent: 0, soon: 1, routine: 2 } as const;

function workItems(c: UserCtx): (WorkItem & { bucket: Set<WorklistBucket> })[] {
  const { db, locale, account, now } = c;
  const me = account.id;
  const out: (WorkItem & { bucket: Set<WorklistBucket> })[] = [];
  const add = (w: WorkItem, buckets: (WorklistBucket | false)[]) => {
    const bucket = new Set(buckets.filter((b): b is WorklistBucket => b !== false));
    if (w.assigned_to?.id === me && !bucket.has("done")) bucket.add("mine");
    if (bucket.size) out.push({ ...w, bucket });
  };
  for (const v of db.visits) {
    const pending = v.status === "submitted" || v.status === "red_flag";
    add(
      {
        type: "visit",
        id: v.id,
        patient: personOr(db, v.patient_id, locale),
        title: v.intake.chief_complaint ?? v.title,
        subtitle: v.red_flag ? L(locale, `紅旗：${v.red_flag.label}`, `Red flag: ${v.red_flag.label}`) : (v.summary?.narrative ?? v.title),
        urgency: v.urgency,
        status: v.status,
        assigned_to: person(db, v.assigned_to, locale),
        due_at: v.appointment_id ? (db.appointments.find((a) => a.id === v.appointment_id)?.starts_at ?? null) : null,
        updated_at: v.last_activity_at,
        link: `/clinic/visits/${v.id}`,
      },
      [pending && "pending", pending && v.urgency === "urgent" && "urgent", v.mode === "human" && v.status !== "reviewed" && "waiting", v.status === "reviewed" && "done"],
    );
  }
  for (const r of db.rx) {
    if (r.kind === "refill" && r.status !== "returned") continue;
    if (r.status === "draft" || r.status === "cancelled") continue;
    const b = rxBrief(c, r);
    const review = r.status === "in_review" || r.status === "submitted" || r.status === "returned";
    add(
      {
        type: "rx",
        id: r.id,
        patient: b.patient,
        title: b.drug_names.join("、"),
        subtitle: r.engine?.summary ?? b.no,
        urgency: r.priority,
        status: r.status,
        assigned_to: b.assigned_to,
        due_at: r.sla_due_at,
        updated_at: r.updated_at,
        link: `/clinic/rx/${r.id}`,
      },
      [review && "pending", review && (r.priority === "urgent" || b.overdue) && "urgent", r.status === "more_info" && "waiting", !isOpenRx(r.status) && "done"],
    );
  }
  for (const t of db.tickets) {
    add(
      {
        type: "ticket",
        id: t.id,
        patient: personOr(db, t.patient_id, locale),
        title: t.summary,
        subtitle: t.ticket_no,
        urgency: t.urgency,
        status: t.status,
        assigned_to: null,
        due_at: null,
        updated_at: t.resolved_at ?? t.created_at,
        link: t.visit_id ? `/clinic/visits/${t.visit_id}` : `/clinic/rx/${t.rx_id}`,
      },
      [t.status === "open" && "pending", t.status === "open" && t.urgency === "urgent" && "urgent", t.status === "resolved" && "done"],
    );
  }
  const overdue = (w: WorkItem) => (w.due_at !== null && w.due_at < now ? 0 : 1);
  return out.sort((a, b) => RANK[a.urgency] - RANK[b.urgency] || overdue(a) - overdue(b) || b.updated_at.localeCompare(a.updated_at));
}
const todayRows = (c: UserCtx, date: string): AppointmentRec[] => c.db.appointments.filter((a) => taipeiDate(a.starts_at) === date).sort((a, b) => a.starts_at.localeCompare(b.starts_at));

const editableNote = (c: UserCtx, v: VisitRec) => {
  if (v.note?.status === "signed") fail("invalid_state");
  checkRevision(c, v.note?.revision ?? 0, () => noteView(c, v));
};

export const clinicRoutes: Route[] = [
  route("GET /clinic/overview", ["visit.read"], (c) => {
    const { db, locale, now } = c;
    const empty = c.server.config.empty;
    const items = workItems(c);
    const review = db.rx.filter((r) => r.status === "in_review");
    return ok({
      counts: empty
        ? { urgent: 0, pending: 0, rx_review: 0, overdue: 0, waiting_patient: 0, tickets: 0 }
        : {
            urgent: items.filter((i) => i.bucket.has("urgent")).length,
            pending: items.filter((i) => i.type === "visit" && i.bucket.has("pending")).length,
            rx_review: review.length,
            overdue: review.filter((r) => r.sla_due_at !== null && r.sla_due_at < now).length,
            waiting_patient: db.rx.filter((r) => r.status === "more_info").length + db.visits.filter((v) => v.mode === "human").length,
            tickets: db.tickets.filter((t) => t.status === "open").length,
          },
      today: empty ? [] : todayRows(c, todayOf(now)).map((a) => ({ appointment: appointmentView(db, a, locale), patient: personOr(db, a.patient_id, locale), previsit: previsitState(db, a.id) })),
      activity: empty
        ? []
        : [
            ...db.visits.filter((v) => v.submitted_at).map((v) => ({ at: v.submitted_at!, text: L(locale, `${personOr(db, v.patient_id, locale).display_name}送出預問診「${v.title}」`, `${personOr(db, v.patient_id, locale).display_name} sent a previsit`), link: `/clinic/visits/${v.id}` })),
            ...db.rx.flatMap((r) => r.timeline.filter((e) => e.type !== "created").map((e) => ({ at: e.at, text: `${r.no} ${L(locale, e.zh, e.en)}`, link: `/clinic/rx/${r.id}` }))),
          ]
            .sort((a, b) => b.at.localeCompare(a.at))
            .slice(0, 12),
    });
  }),
  route("GET /clinic/worklist", ["visit.read"], (c) => {
    const bucket = (c.q("bucket") ?? "pending") as WorklistBucket;
    const q = (c.q("q") ?? "").toLowerCase();
    const items = workItems(c);
    const counts = Object.fromEntries((["urgent", "pending", "mine", "waiting", "done"] as const).map((b) => [b, c.server.config.empty ? 0 : items.filter((i) => i.bucket.has(b)).length]));
    const list = items.filter((i) => i.bucket.has(bucket) && (!q || `${i.patient.display_name} ${i.title} ${i.subtitle}`.toLowerCase().includes(q)));
    if (c.q("sort") === "updated") list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (c.q("sort") === "due") list.sort((a, b) => (a.due_at ?? "9").localeCompare(b.due_at ?? "9"));
    return page(c, list.map(({ bucket: _b, ...w }) => w), { counts });
  }),

  // ---- thread ----
  route("POST /visits/:id/assign", ["visit.review"], (c) => {
    const v = visitFor(c);
    const id = c.body.account_id === null ? null : str(c.body.account_id);
    if (id) must(c.db.accounts.find((a) => a.id === id && a.role !== "patient"));
    v.assigned_to = id;
    emitVisit(c.server, v, "visit.updated", visitView(c, v));
    visitChanged(c.server, v);
    return ok({ visit: visitView(c, v) });
  }),
  route("POST /visits/:id/takeover", ["thread.reply"], (c) => {
    const v = visitFor(c);
    if (v.mode === "human") fail("invalid_state");
    v.mode = "human";
    v.assigned_to = c.account.id;
    addMessage(c.server, c.db, v, { role: "assistant", kind: "handoff", content: L(v.locale, `${c.account.display_name}${c.account.title ?? ""}已接手，AI 先暫停回覆。`, `${c.account.display_name_en} has taken over. The AI is paused.`) });
    emitVisit(c.server, v, "mode.changed", { mode: "human", by: person(c.db, c.account.id, v.locale) });
    emitVisit(c.server, v, "visit.updated", visitView(c, v));
    audit(c, "clinic", "visit.takeover", `visit:${v.id}`);
    visitChanged(c.server, v);
    return ok({ visit: visitView(c, v) });
  }),
  route("POST /visits/:id/release", ["thread.reply"], (c) => {
    const v = visitFor(c);
    if (v.mode !== "human") fail("invalid_state");
    v.mode = "ai";
    addMessage(c.server, c.db, v, { role: "assistant", kind: "handoff", content: L(v.locale, "醫療團隊已結束這段對話，接下來由 AI 預問診助理繼續。", "The care team has finished. The AI previsit assistant continues.") });
    emitVisit(c.server, v, "mode.changed", { mode: "ai", by: person(c.db, c.account.id, v.locale) });
    emitVisit(c.server, v, "visit.updated", visitView(c, v));
    audit(c, "clinic", "visit.release", `visit:${v.id}`);
    visitChanged(c.server, v);
    return ok({ visit: visitView(c, v) });
  }),
  route("POST /visits/:id/staff-messages", ["thread.reply"], (c) => {
    const v = visitFor(c);
    const { content, clientId } = checkMessage(c);
    const known = v.messages.find((m) => m.client_id === clientId);
    if (known) return ok({ message: messageView(c.db, known, c.locale) });
    if (v.mode !== "human") fail("invalid_state");
    const message = addMessage(c.server, c.db, v, { role: "staff", kind: "chat", content, client_id: clientId, author_id: c.account.id });
    notify(c.server, c.db, v.patient_id, "visit.staff_message", ["醫療團隊回覆了", "The care team replied", `${c.account.display_name}回覆了您的預問診。`, `${c.account.display_name_en} replied in your previsit.`], `/app/visits/${v.id}`);
    visitChanged(c.server, v);
    return { status: 202, body: { message } };
  }),

  // ---- note ----
  route("GET /visits/:id/note", ["visit.read"], (c) => ok(noteView(c, visitFor(c, true)))),
  route("PUT /visits/:id/note", ["visit.review"], (c) => {
    const v = visitFor(c);
    editableNote(c, v);
    const sections = c.body.sections as ClinicalNoteSections | undefined;
    if (!sections || typeof sections.subjective !== "string") badField("sections", "sections");
    v.note = {
      revision: (v.note?.revision ?? 0) + 1,
      version: v.note?.version ?? 1,
      status: "draft",
      sections: sections!,
      author_id: c.account.id,
      signed_by: null,
      signed_at: null,
      addenda: v.note?.addenda ?? [],
      history: [...(v.note?.history ?? []), { version: (v.note?.revision ?? 0) + 1, by: c.account.id, at: c.now }],
    };
    return ok(noteView(c, v));
  }),
  route("POST /visits/:id/note/sign", ["note.sign"], (c) => {
    const v = visitFor(c);
    if (!v.note) return fail("invalid_state");
    editableNote(c, v);
    const s = v.note.sections;
    const fields: Record<string, string> = {};
    for (const k of ["assessment", "plan"] as const) if (!s[k].trim()) fields[k] = L(c.locale, "簽署前要填。", "Required before signing.");
    if (Object.keys(fields).length) fail("invalid_request", { fields });
    Object.assign(v.note, { status: "signed", signed_by: c.account.id, signed_at: c.now, revision: v.note.revision + 1 });
    v.status = "reviewed";
    v.mode = "ai";
    v.reviewed_at = c.now;
    v.reviewed_by = c.account.id;
    v.updated_at = c.now;
    v.last_activity_at = c.now;
    emitVisit(c.server, v, "note.signed", {});
    emitVisit(c.server, v, "visit.updated", visitView(c, v));
    audit(c, "clinic", "note.sign", `visit:${v.id}`, { version: v.note.version });
    notify(c.server, c.db, v.patient_id, "visit.reviewed", ["醫師已看過您的預問診", "Your previsit was reviewed", `${c.account.display_name}${c.account.title ?? ""}留了一段話給您。`, `${c.account.display_name_en} left you a message.`], `/app/visits/${v.id}`);
    visitChanged(c.server, v);
    return ok(noteView(c, v));
  }),
  route("POST /visits/:id/note/addendum", ["note.sign"], (c) => {
    const v = visitFor(c);
    if (v.note?.status !== "signed") return fail("invalid_state");
    const body = str(c.body.body).trim();
    if (!body) badField("body", L(c.locale, "請輸入內容。", "Write something."));
    v.note.addenda.push({ body, by: c.account.id, at: c.now });
    audit(c, "clinic", "note.addendum", `visit:${v.id}`);
    return created(noteView(c, v));
  }),

  // ---- tickets ----
  route("GET /clinic/tickets", ["ticket.handle"], (c) => {
    const status = c.q("status") ?? "open";
    const list = c.db.tickets.filter((t) => status === "all" || t.status === status);
    return page(c, list.sort((a, b) => RANK[a.urgency] - RANK[b.urgency] || b.created_at.localeCompare(a.created_at)).map((t) => ticketView(c.db, t, c.locale, true)));
  }),
  route("POST /clinic/tickets/:id/resolve", ["ticket.handle"], (c) => {
    const t = must(c.db.tickets.find((x) => x.id === c.params.id));
    if (t.status !== "open") fail("invalid_state");
    Object.assign(t, { status: "resolved", resolved_at: c.now, resolved_by: c.account.display_name, resolution_note: str(c.body.note) || null });
    audit(c, "clinic", "ticket.resolve", `ticket:${t.ticket_no}`);
    c.server.live.publish({ to: { permission: "ticket.handle" }, seq: null, type: "queue.changed", data: { name: "tickets" } });
    return ok({ ticket: ticketView(c.db, t, c.locale, true) });
  }),

  // ---- patients ----
  route("GET /clinic/patients", ["patient.read"], (c) => {
    const q = (c.q("q") ?? "").trim().toLowerCase();
    const rows = c.db.accounts
      .filter((a) => a.role === "patient" && !a.is_guest)
      .map((a) => patientRow(c, a))
      .filter(
        (r) =>
          (!q || `${r.patient.display_name} ${r.conditions.join(" ")} ${r.tags.join(" ")}`.toLowerCase().includes(q)) &&
          (!c.q("tag") || r.tags.includes(c.q("tag")!)) &&
          (!c.q("status") || r.care_status === c.q("status")) &&
          (!c.q("assigned") || r.physician?.id === c.q("assigned") || r.coordinator?.id === c.q("assigned") || (c.q("assigned") === "me" && [r.physician?.id, r.coordinator?.id].includes(c.account.id))),
      );
    return page(c, rows.sort((a, b) => b.open_items - a.open_items || a.patient.display_name.localeCompare(b.patient.display_name, "zh-TW")));
  }),
  route("GET /clinic/patients/:id", ["patient.read"], (c) => {
    const { db, locale, account } = c;
    const a = must(db.accounts.find((x) => x.id === c.params.id && x.role === "patient"));
    logAccess(c, a.id, "patient.read", `patient:${a.id}`, "病人資料");
    const profile = must(db.profiles[a.id]);
    const limited = account.role === "pharmacist";
    const visits = db.visits.filter((v) => v.patient_id === a.id).sort((x, y) => y.last_activity_at.localeCompare(x.last_activity_at));
    const rx = db.rx.filter((r) => r.patient_id === a.id && r.status !== "draft").sort((x, y) => y.updated_at.localeCompare(x.updated_at));
    const appts = db.appointments.filter((x) => x.patient_id === a.id).sort((x, y) => y.starts_at.localeCompare(x.starts_at));
    const tickets = db.tickets.filter((t) => t.patient_id === a.id);
    const timeline: TimelineEntry[] = [
      ...visits.map((v): TimelineEntry => ({ at: v.submitted_at ?? v.created_at, kind: "visit", title: v.title, link: `/clinic/visits/${v.id}`, actor: null })),
      ...visits.filter((v) => v.reviewed_at).map((v): TimelineEntry => ({ at: v.reviewed_at!, kind: "note", title: L(locale, `簽署筆記：${v.title}`, `Note signed: ${v.title}`), link: `/clinic/visits/${v.id}`, actor: person(db, v.reviewed_by, locale) })),
      ...rx.map((r): TimelineEntry => ({ at: r.submitted_at ?? r.created_at, kind: "rx", title: `${r.no} ${rxBrief(c, r).drug_names.join("、")}`, link: `/clinic/rx/${r.id}`, actor: null })),
      ...appts.map((x): TimelineEntry => ({ at: x.starts_at, kind: "appointment", title: `${L(locale, x.department_zh, x.department_en)} ${x.reason ?? ""}`.trim(), link: null, actor: person(db, x.physician_id, locale) })),
      ...tickets.map((t): TimelineEntry => ({ at: t.created_at, kind: "ticket", title: t.summary, link: t.visit_id ? `/clinic/visits/${t.visit_id}` : `/clinic/rx/${t.rx_id}`, actor: null })),
      ...db.contacts.filter((x) => x.patient_id === a.id).map((x): TimelineEntry => ({ at: x.at, kind: `contact.${x.channel}`, title: x.body, link: null, actor: person(db, x.author_id, locale) })),
    ].sort((x, y) => y.at.localeCompare(x.at));
    const detail: PatientDetail = {
      row: patientRow(c, a),
      profile: limited ? { ...profile, conditions: [], family_history: [], lifestyle: { smoking: null, alcohol: null, exercise: null } } : profile,
      medications: medications(db, a.id, todayOf(c.now), locale),
      measurements: limited ? [] : db.measurements.filter((m) => m.patient_id === a.id).sort((x, y) => y.taken_at.localeCompare(x.taken_at)).map(({ patient_id: _p, ...m }) => m),
      visits: limited ? [] : visits.map((v) => visitView(c, v)),
      rx: rx.map((r) => rxBrief(c, r)),
      appointments: limited ? [] : appts.map((x) => appointmentView(db, x, locale)),
      tickets: limited ? [] : tickets.map((t) => ticketView(db, t, locale, true)),
      notes: limited ? [] : db.staff_notes.filter((n) => n.patient_id === a.id).sort((x, y) => Number(y.pinned) - Number(x.pinned) || y.created_at.localeCompare(x.created_at)).map((n) => ({ id: n.id, author: personOr(db, n.author_id, locale), body: n.body, pinned: n.pinned, created_at: n.created_at })),
      timeline: limited ? [] : timeline,
    };
    return ok(detail);
  }),
  route("PATCH /clinic/patients/:id", ["patient.manage"], (c) => {
    const a = must(c.db.accounts.find((x) => x.id === c.params.id && x.role === "patient"));
    const care = (c.db.care[a.id] ??= { tags: [], care_status: "new", physician_id: null, coordinator_id: null, last_contact_at: null, flags: [] });
    if (Array.isArray(c.body.tags)) care.tags = [...new Set(c.body.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
    if (["new", "active", "watch", "inactive"].includes(str(c.body.care_status))) care.care_status = c.body.care_status as CareStatus;
    if ("physician_id" in c.body) care.physician_id = str(c.body.physician_id) || null;
    if ("coordinator_id" in c.body) care.coordinator_id = str(c.body.coordinator_id) || null;
    return ok({ row: patientRow(c, a) });
  }),
  route("POST /clinic/patients/:id/notes", ["patient.manage"], (c) => {
    must(c.db.accounts.find((x) => x.id === c.params.id && x.role === "patient"));
    const body = str(c.body.body).trim();
    if (!body) badField("body", L(c.locale, "請輸入內容。", "Write something."));
    const n = { id: uuid(), patient_id: c.params.id, author_id: c.account.id, body, pinned: c.body.pinned === true, created_at: c.now };
    c.db.staff_notes.unshift(n);
    return created({ note: { id: n.id, author: personOr(c.db, n.author_id, c.locale), body, pinned: n.pinned, created_at: n.created_at } });
  }),
  route("PATCH /clinic/notes/:id", ["patient.manage"], (c) => {
    const n = must(c.db.staff_notes.find((x) => x.id === c.params.id));
    if (typeof c.body.body === "string" && c.body.body.trim()) n.body = c.body.body.trim();
    if (typeof c.body.pinned === "boolean") n.pinned = c.body.pinned;
    return ok({ note: { id: n.id, author: personOr(c.db, n.author_id, c.locale), body: n.body, pinned: n.pinned, created_at: n.created_at } });
  }),
  route("DELETE /clinic/notes/:id", ["patient.manage"], (c) => {
    must(c.db.staff_notes.find((x) => x.id === c.params.id));
    c.db.staff_notes = c.db.staff_notes.filter((x) => x.id !== c.params.id);
    return DONE;
  }),
  route("POST /clinic/patients/:id/contact", ["patient.manage"], (c) => {
    const a = must(c.db.accounts.find((x) => x.id === c.params.id && x.role === "patient"));
    const body = str(c.body.body).trim();
    if (!body) badField("body", L(c.locale, "請輸入內容。", "Write something."));
    const channel = c.body.channel === "phone_note" ? "phone_note" : "in_app";
    c.db.contacts.unshift({ at: c.now, patient_id: a.id, author_id: c.account.id, channel, body });
    const care = c.db.care[a.id];
    if (care) care.last_contact_at = c.now;
    if (channel === "in_app") {
      const v = c.db.visits.filter((x) => x.patient_id === a.id).sort((x, y) => y.last_activity_at.localeCompare(x.last_activity_at))[0];
      if (v) addMessage(c.server, c.db, v, { role: "staff", kind: "chat", content: body, author_id: c.account.id });
      notify(c.server, c.db, a.id, "visit.staff_message", ["醫療團隊傳訊息給您", "A message from the care team", body, body], v ? `/app/visits/${v.id}` : "/app/messages");
    }
    return created({ ok: true });
  }),

  // ---- schedule ----
  route("GET /clinic/schedule", ["visit.read"], (c) => {
    const date = isValidDate(c.q("date") ?? "") ? c.q("date")! : todayOf(c.now);
    const rows = c.server.config.empty ? [] : todayRows(c, date);
    return ok({
      date,
      physicians: physicianKeys.map((key) => {
        const id = fid(`account:${key}`);
        const mine = rows.filter((a) => a.physician_id === id);
        const times = [...new Set([...slotTimes(key, date), ...mine.map((a) => a.starts_at)])].sort();
        return {
          physician: personOr(c.db, id, c.locale),
          slots: times.map((starts_at) => {
            const a = mine.find((x) => x.starts_at === starts_at);
            return { slot_id: `${key}|${starts_at}`, starts_at, minutes: 15, appointment: a ? appointmentView(c.db, a, c.locale) : null, patient: a ? personOr(c.db, a.patient_id, c.locale) : null, previsit: a ? previsitState(c.db, a.id) : "none" };
          }),
        };
      }),
    });
  }),
  route("GET /staff", ["visit.read", "rx.read"], (c) =>
    ok({ items: c.db.accounts.filter((a) => a.role !== "patient" && a.role !== "admin" && a.status === "active").map((a) => personOr(c.db, a.id, c.locale)) }),
  ),
];
