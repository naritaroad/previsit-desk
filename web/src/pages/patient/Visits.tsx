import { IconMessage2, IconPin, IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { Visit, VisitStatus } from "@/api/types";
import { useSavedFilter, useVisits } from "@/data";
import { Button, ButtonLink, EmptyState, NativeSelect, PageBody, PageHeader, SearchInput, Segmented, SkeletonRows, StatusTag } from "@/ui";

import { LoadError, StaleNote, useDebounced, useFmt } from "./shared";
import { VisitMenu } from "./visit/VisitRail";

const STATUSES: readonly VisitStatus[] = ["active", "red_flag", "submitted", "reviewed"];
const NO_FILTER = { box: "current", status: "" };

export default function Visits() {
  const { t } = useTranslation(["patient", "rx"]);
  const [saved, setSaved] = useSavedFilter("patient_visits", NO_FILTER);
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim());
  const status = STATUSES.find((s) => s === saved.status);
  const archived = saved.box === "archived";
  const list = useVisits({ archived, ...(status ? { status } : {}), ...(query ? { q: query } : {}) });
  const filtered = Boolean(query || status);
  return (
    <PageBody>
      <PageHeader
        title={t("patient:visits.title")}
        lede={t("patient:visits.lede")}
        actions={
          <ButtonLink to="/app/visits/new" variant="primary" icon={<IconPlus aria-hidden />}>
            {t("patient:visits.start")}
          </ButtonLink>
        }
      />
      <div className="mb-stack flex flex-wrap items-center gap-3" role="search">
        <SearchInput value={q} onValueChange={setQ} placeholder={t("patient:visits.search")} className="max-w-md flex-1 basis-64" />
        <div className="w-44">
          <NativeSelect aria-label={t("patient:visits.statusFilter")} value={saved.status} onChange={(e) => setSaved({ status: e.target.value })}>
            <option value="">{t("patient:visits.anyStatus")}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`rx:visitStatus.${s}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Segmented
          label={t("patient:visits.box")}
          value={saved.box}
          onValueChange={(box) => setSaved({ box })}
          options={[
            { value: "current", label: t("patient:visits.current") },
            { value: "archived", label: t("patient:visits.archivedBox") },
          ]}
        />
      </div>
      <StaleNote query={list} />
      {!list.data && list.error ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : !list.data ? (
        <SkeletonRows rows={5} />
      ) : list.items.length === 0 ? (
        <EmptyState
          icon={<IconMessage2 aria-hidden />}
          title={filtered ? t("patient:visits.noMatch") : t(archived ? "patient:visits.noneArchived" : "patient:visits.none")}
          action={
            filtered ? (
              <Button
                onClick={() => {
                  setQ("");
                  setSaved({ status: "" });
                }}
              >
                {t("patient:common.clearFilter")}
              </Button>
            ) : archived ? undefined : (
              <ButtonLink to="/app/visits/new">{t("patient:visits.start")}</ButtonLink>
            )
          }
        >
          {filtered ? null : t(archived ? "patient:visits.noneArchivedBody" : "patient:visits.noneBody")}
        </EmptyState>
      ) : (
        <>
          <ul className="row-list">
            {list.items.map((v) => (
              <VisitRow key={v.id} visit={v} />
            ))}
          </ul>
          {list.hasNextPage && (
            <div className="mt-4">
              <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
                {t("patient:common.more")}
              </Button>
            </div>
          )}
        </>
      )}
    </PageBody>
  );
}

function VisitRow({ visit: v }: { visit: Visit }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  return (
    <li className="row-item">
      <Link to={`/app/visits/${v.id}`} className="row-link" data-unread={v.has_unread}>
        <span className="row-main">
          <span className="row-title">
            {v.pinned && <IconPin size={17} className="me-1 inline align-[-0.15em] text-fg-2" aria-label={t("visits.pinned")} />}
            {v.has_unread && <span className="sr-only">{t("visits.unread")}</span>}
            {v.title}
          </span>
          <span className="row-sub">
            {v.mode === "human"
              ? t("visits.human", { name: f.person(v.assigned_to) || t("common.careTeam") })
              : v.appointment
                ? t("visits.forAppt", { date: f.dateTime(v.appointment.starts_at), doctor: f.person(v.appointment.physician) })
                : t("visits.noAppt")}
          </span>
        </span>
        <span className="row-end">
          <StatusTag family="visit" status={v.status} />
          <time className="num text-sm text-fg-2" dateTime={v.last_activity_at}>
            {f.relative(v.last_activity_at)}
          </time>
        </span>
      </Link>
      <VisitMenu visit={v} />
    </li>
  );
}
