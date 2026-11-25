import { IconArchive, IconArchiveOff, IconDots, IconPencil, IconPin, IconPinnedOff } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Visit } from "@/api/types";
import { useUpdateVisit, useVisits } from "@/data";
import { ConversationLink, PatientRail } from "@/shells/PatientShell";
import { Button, Dialog, Field, Input, Menu, MenuItem, SearchInput, StatusTag, TextLink, toast } from "@/ui";

import { ActionError, useDebounced, useErrorText, useFmt } from "../shared";

const SHOWN = 10;

/** The conversation list under the navigation: search, pin, rename, archive, unread. */
export function VisitRail() {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim());
  const visits = useVisits({ archived: false, ...(query ? { q: query } : {}) });
  const items = visits.items.slice(0, SHOWN);
  if (!visits.data) return null;
  return (
    <PatientRail>
      <section className="rail-convos" aria-label={t("visits.railLabel")}>
        <SearchInput value={q} onValueChange={setQ} placeholder={t("visits.search")} className="mb-2" />
        {items.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-fg-2">{query ? t("visits.noMatch") : t("visits.railEmpty")}</p>
        ) : (
          <ul>
            {items.map((v) => (
              <li key={v.id} className="convo-row">
                <ConversationLink
                  to={`/app/visits/${v.id}`}
                  title={v.title}
                  time={f.relative(v.last_activity_at)}
                  unread={v.has_unread}
                  pinned={v.pinned ? <IconPin size={15} className="text-fg-2" aria-label={t("visits.pinned")} /> : undefined}
                  status={<StatusTag family="visit" status={v.status} plain />}
                />
                <VisitMenu visit={v} small />
              </li>
            ))}
          </ul>
        )}
        {visits.items.length > 0 && (
          <p className="px-2.5 pt-1.5 text-sm">
            <TextLink to="/app/visits">{t("visits.all")}</TextLink>
          </p>
        )}
      </section>
    </PatientRail>
  );
}

/** Pin, rename, archive. Archiving can be undone from the toast, so it does not ask first. */
export function VisitMenu({ visit, small }: { visit: Visit; small?: boolean }) {
  const { t } = useTranslation("patient");
  const update = useUpdateVisit();
  const errorText = useErrorText();
  const [renaming, setRenaming] = useState(false);
  const fail = (e: unknown) => toast.warn(errorText(e));
  const archive = () =>
    update.mutate(
      { id: visit.id, archived: !visit.archived },
      {
        onError: fail,
        onSuccess: () =>
          toast.ok(t(visit.archived ? "visits.restored" : "visits.archivedDone"), {
            action: { label: t("common.undo"), onClick: () => update.mutate({ id: visit.id, archived: visit.archived }, { onError: fail }) },
          }),
      },
    );
  return (
    <>
      <Menu
        trigger={
          <button type="button" className="icon-btn" data-size={small ? "sm" : undefined} aria-label={t("visits.menu", { title: visit.title })}>
            <IconDots size={20} aria-hidden />
          </button>
        }
      >
        <MenuItem icon={visit.pinned ? <IconPinnedOff aria-hidden /> : <IconPin aria-hidden />} onSelect={() => update.mutate({ id: visit.id, pinned: !visit.pinned }, { onError: fail })}>
          {visit.pinned ? t("visits.unpin") : t("visits.pin")}
        </MenuItem>
        <MenuItem icon={<IconPencil aria-hidden />} onSelect={() => setRenaming(true)}>
          {t("visits.rename")}
        </MenuItem>
        <MenuItem icon={visit.archived ? <IconArchiveOff aria-hidden /> : <IconArchive aria-hidden />} onSelect={archive}>
          {visit.archived ? t("visits.restore") : t("visits.archive")}
        </MenuItem>
      </Menu>
      <RenameDialog visit={visit} open={renaming} onOpenChange={setRenaming} />
    </>
  );
}

function RenameDialog({ visit, open, onOpenChange }: { visit: Visit; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation("patient");
  const update = useUpdateVisit();
  const [title, setTitle] = useState(visit.title);
  const { reset } = update;
  useEffect(() => {
    if (open) {
      setTitle(visit.title);
      reset();
    }
  }, [open, visit.title, reset]);
  const text = title.trim();
  const error = text === "" ? t("visits.titleEmpty") : [...text].length > 60 ? t("visits.titleLong") : undefined;
  const save = () => {
    if (!error) update.mutate({ id: visit.id, title: text }, { onSuccess: () => onOpenChange(false) });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("visits.rename")}
      width="26rem"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={save} loading={update.isPending} disabled={Boolean(error)}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label={t("visits.titleLabel")} error={error}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <ActionError error={update.error} className="mt-3" />
      </form>
    </Dialog>
  );
}
