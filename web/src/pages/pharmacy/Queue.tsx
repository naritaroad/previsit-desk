import { IconAlertTriangle, IconPackageOff } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";

import { formatDate, formatRelativeDay, formatTime } from "@/lib/format";
import { paths } from "@/lib/links";
import { PHARMACY_STAGES, type PharmacyStage } from "@/shells/PharmacyShell";
import { FillPage } from "@/shells/StaffShell";
import { Badge, Button, ButtonLink, DataTable, EmptyState, FilterBar, Kbd, SearchInput, Segmented, Select, StatusTag, useHotkey, useLocale, type Column } from "@/ui";

import { type BoardRow, byWork, pickupKey, pickupState, useBoard } from "./board";
import { LoadProblem } from "./shared/problem";
import { personName } from "./shared/names";

const isStage = (s: string | undefined): s is PharmacyStage => PHARMACY_STAGES.some((x) => x === s);
const TO_DO: readonly PharmacyStage[] = ["check", "prepare", "ready", "returned"];

export default function Queue() {
  const { t } = useTranslation("pharmacy");
  const { t: ts } = useTranslation("shell");
  const locale = useLocale();
  const navigate = useNavigate();
  const { stage: param } = useParams();
  const stage = isStage(param) ? param : null;
  const board = useBoard();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const [when, setWhen] = useState("all");
  const box = useRef<HTMLDivElement>(null);
  useHotkey("/", (e) => {
    e.preventDefault();
    box.current?.querySelector("input")?.focus();
  });

  const now = new Date();
  const base = stage ? board.rows[stage] : TO_DO.flatMap((s) => board.rows[s]).sort(byWork);
  const hasWindows = base.some((r) => r.pickup_window);
  const needle = q.trim().toLowerCase();
  const rows = base.filter(
    (r) =>
      (kind === "all" || r.kind === kind) &&
      (when === "all" || pickupState(r, now, board.today) === when) &&
      (!needle || `${r.no} ${r.patient.display_name} ${r.drug_names.join(" ")}`.toLowerCase().includes(needle)),
  );
  const first = rows[0];
  const open = (r: BoardRow) => void navigate(paths.pharmacy.rx(r.id), { state: { stage } });
  useHotkey("n", () => first && open(first));

  const filtered = needle !== "" || kind !== "all" || when !== "all";
  const clear = () => {
    setQ("");
    setKind("all");
    setWhen("all");
  };
  // A scanner or a typed number ends with Enter: go straight to that request.
  const exact = needle ? Object.values(board.rows).flat().find((r) => r.no.toLowerCase() === needle) : undefined;

  const columns: Column<BoardRow>[] = [
    {
      id: "no",
      header: t("queue.no"),
      cell: (r) => (
        <span className="grid gap-0.5">
          <span className="num font-semibold">{r.no}</span>
          {r.priority !== "routine" && (
            <span>
              <StatusTag family="urgency" status={r.priority} />
            </span>
          )}
        </span>
      ),
      sortValue: (r) => r.no,
      nowrap: true,
      width: "12.5rem",
      card: "title",
    },
    { id: "p", header: t("queue.patient"), cell: (r) => <span className="text-base font-semibold">{r.patient.display_name}</span>, sortValue: (r) => r.patient.display_name, width: "9rem" },
    { id: "d", header: t("queue.drugs"), cell: (r) => r.drug_names.join(t("listSep")) },
    ...(hasWindows ? [{ id: "w", header: t("queue.pickup"), cell: (r: BoardRow) => <Pickup row={r} now={now} today={board.today} />, sortValue: pickupKey, width: "12rem" } satisfies Column<BoardRow>] : []),
    { id: "k", header: t("queue.kind"), cell: (r) => <Kind row={r} />, width: "7.5rem", hideBelow: "lg" },
    stage
      ? { id: "a", header: t("queue.handler"), cell: (r) => (r.assigned_to ? personName(r.assigned_to) : <span className="text-fg-3">{t("queue.noHandler")}</span>), width: "10rem", hideBelow: "lg" }
      : { id: "s", header: t("queue.stage"), cell: (r) => <StatusTag family="rx" status={r.status} />, sortValue: (r) => r.status, width: "9rem", card: "end" },
    {
      id: "t",
      header: stage === "done" ? t("queue.doneAt") : t("queue.sent"),
      cell: (r) => {
        const at = stage === "done" ? r.updated_at : r.submitted_at;
        return at ? <span className="whitespace-nowrap">{stage === "done" ? formatTime(at, locale) : `${formatDate(at, locale, "month_day")} ${formatTime(at, locale)}`}</span> : null;
      },
      sortValue: (r) => (stage === "done" ? r.updated_at : r.submitted_at),
      align: "end",
      width: "9.5rem",
      hideBelow: "md",
    },
    {
      id: "go",
      header: <span className="sr-only">{t("queue.next")}</span>,
      cell: (r) => (
        <ButtonLink to={paths.pharmacy.rx(r.id)} size="sm" variant="soft" tabIndex={-1} state={{ stage }}>
          {t(`queue.act.${stage ?? stageAct(r)}`)}
        </ButtonLink>
      ),
      width: "7.5rem",
      align: "end",
      card: "hide",
    },
  ];

  return (
    <FillPage
      head={
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-pane py-3">
          <h1 className="page-title" tabIndex={-1}>
            {stage ? ts(`pharmacy.stage.${stage}`) : t("queue.allOpen")}
          </h1>
          {stage ? <ButtonLink to="/pharmacy" size="sm" variant="quiet">{t("queue.showAll")}</ButtonLink> : null}
          <p className="ms-auto hidden items-center gap-3 text-sm text-fg-2 lg:flex">
            <span className="inline-flex items-center gap-1.5"><Kbd>/</Kbd>{t("queue.hintSearch")}</span>
            <span className="inline-flex items-center gap-1.5"><Kbd>J</Kbd><Kbd>K</Kbd>{t("queue.hintMove")}</span>
            <span className="inline-flex items-center gap-1.5"><Kbd>N</Kbd>{t("queue.hintNext")}</span>
          </p>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col bg-surface">
        <FilterBar
          search={
            <div ref={box} className="max-w-96">
              <SearchInput
                value={q}
                onValueChange={setQ}
                placeholder={t("queue.search")}
                aria-describedby="queue-search-hint"
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                  const hit = exact ?? (rows.length === 1 ? rows[0] : undefined);
                  if (hit) open(hit);
                }}
              />
              <span id="queue-search-hint" className="sr-only">
                {t("queue.searchHint")}
              </span>
            </div>
          }
          onClearAll={filtered ? clear : undefined}
          chips={filtered && when !== "all" ? [{ key: "w", label: t(`queue.when.${when}`), onRemove: () => setWhen("all") }] : []}
        >
          <Segmented
            label={t("queue.kind")}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "all", label: t("queue.kindAll") },
              { value: "refill", label: t("queue.kindRefill") },
              { value: "renewal", label: t("queue.kindRenewal") },
            ]}
          />
          {hasWindows && <Select size="sm" label={t("queue.pickup")} value={when} onValueChange={setWhen} options={(["all", "past", "today", "tomorrow", "later", "unknown"] as const).map((v) => ({ value: v, label: t(`queue.when.${v}`) }))} />}
        </FilterBar>
        {board.error ? (
          <LoadProblem error={board.error} onRetry={board.refetch} />
        ) : (
          <DataTable
            className="min-h-0 flex-1 overflow-auto"
            caption={stage ? ts(`pharmacy.stage.${stage}`) : t("queue.allOpen")}
            rows={board.ready ? rows : undefined}
            loading={!board.ready}
            rowKey={(r) => r.id}
            rowLink={(r) => paths.pharmacy.rx(r.id)}
            isUrgent={(r) => r.priority === "urgent"}
            empty={
              filtered ? (
                <EmptyState title={t("queue.noMatch")} action={<Button onClick={clear}>{t("queue.clear")}</Button>}>
                  {t("queue.noMatchBody")}
                </EmptyState>
              ) : (
                <EmptyState icon={<IconPackageOff aria-hidden />} title={t(`queue.empty.${stage ?? "all"}`)}>
                  {t(`queue.emptyBody.${stage ?? "all"}`)}
                </EmptyState>
              )
            }
            footer={board.partial ? t("queue.partial", { shown: rows.length }) : t("queue.count", { count: rows.length })}
            columns={columns}
          />
        )}
      </div>
    </FillPage>
  );
}

function stageAct(r: BoardRow): PharmacyStage {
  if (r.status === "ready" || r.status === "returned") return r.status;
  return r.status === "at_pharmacy" && r.assigned_to?.role === "pharmacist" ? "prepare" : "check";
}

function Kind({ row }: { row: BoardRow }) {
  const { t } = useTranslation("rx");
  return <Badge tone={row.kind === "refill" ? "ink" : "info"}>{t(`kind.${row.kind}`)}</Badge>;
}

function Pickup({ row, now, today }: { row: BoardRow; now: Date; today: string }) {
  const { t } = useTranslation("pharmacy");
  const { t: tr } = useTranslation("rx");
  const locale = useLocale();
  const w = row.pickup_window;
  if (!w) return <span className="text-fg-3">{t("queue.noPickup")}</span>;
  const state = pickupState(row, now, today);
  return (
    <span className="grid">
      <span className="num font-medium">
        {state === "today" || state === "tomorrow" ? formatRelativeDay(w.date, locale, today) : formatDate(w.date, locale, "medium")} {tr(`pickupSlot.${w.slot}`)}
      </span>
      {state === "past" && row.status !== "dispensed" && (
        <span className="inline-flex items-center gap-1 text-sm text-warn">
          <IconAlertTriangle size={16} aria-hidden />
          {t("queue.pickupPast")}
        </span>
      )}
    </span>
  );
}
