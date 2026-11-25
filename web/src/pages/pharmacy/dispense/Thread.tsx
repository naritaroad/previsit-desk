import { IconEyeOff, IconUsers } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import type { RxRequest } from "@/api/types";
import { useDraft, useRxMessage } from "@/data";
import { formatDateTime } from "@/lib/format";
import { allows } from "@/lib/rx";
import { Badge, Button, Field, Panel, SaveState, Segmented, Textarea, Timeline, toast, useLocale, type Tone } from "@/ui";

import { personName } from "../shared/names";
import { Problem } from "../shared/problem";

interface Draft {
  body: string;
  visibility: "all" | "staff";
}
const EMPTY: Draft = { body: "", visibility: "staff" };
const MAX = 1000;

/** Notes between staff and messages the patient reads, in one list; who can read each one is written on it. */
export function Messages({ rx }: { rx: RxRequest }) {
  const { t } = useTranslation("pharmacy");
  const locale = useLocale();
  const draft = useDraft<Draft>(`rx:${rx.id}:pharmacy`, EMPTY);
  const send = useRxMessage(rx.id);
  const { body, visibility } = draft.value;
  const list = [...rx.messages].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return (
    <Panel title={t("thread.title")} meta={draft.dirty || draft.savedAt ? <SaveState state={draft.status === "saving" ? "saving" : draft.status === "offline" ? "offline" : "saved"} /> : undefined}>
      {list.length === 0 ? (
        <p className="text-fg-2">{t("thread.empty")}</p>
      ) : (
        <ul className="grid gap-0 divide-y divide-rule">
          {list.map((m) => (
            <li key={m.id} className="py-2.5 first:pt-0">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-2">
                <span className="font-semibold text-fg">{personName(m.author)}</span>
                <time dateTime={m.created_at}>{formatDateTime(m.created_at, locale)}</time>
                <Who visibility={m.visibility} />
              </p>
              <p className="mt-0.5 whitespace-pre-wrap">{m.body}</p>
            </li>
          ))}
        </ul>
      )}
      {allows(rx, "message") && (
        <form
          className="mt-4 grid gap-3 border-t border-rule pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            const text = body.trim();
            if (!text || send.isPending) return;
            send.mutate(
              { body: text, visibility },
              {
                onSuccess: () => {
                  void draft.clear();
                  toast.ok(t(visibility === "all" ? "thread.sentAll" : "thread.sentStaff"));
                },
              },
            );
          }}
        >
          <Segmented
            label={t("thread.who")}
            value={visibility}
            onValueChange={(v) => draft.set((d) => ({ ...d, visibility: v as Draft["visibility"] }))}
            options={[
              { value: "staff", label: t("thread.staff") },
              { value: "all", label: t("thread.all") },
            ]}
          />
          <Field label={t("thread.label")} hint={visibility === "all" ? t("thread.hintAll") : t("thread.hintStaff")}>
            <Textarea rows={3} maxLength={MAX} value={body} onChange={(e) => draft.set((d) => ({ ...d, body: e.target.value }))} />
          </Field>
          {send.error ? <Problem error={send.error} /> : null}
          <Button type="submit" className="justify-self-start" disabled={!body.trim()} loading={send.isPending}>
            {visibility === "all" ? t("thread.sendAll") : t("thread.sendStaff")}
          </Button>
        </form>
      )}
    </Panel>
  );
}

function Who({ visibility }: { visibility: "all" | "staff" }) {
  const { t } = useTranslation("pharmacy");
  return visibility === "staff" ? (
    <Badge tone="hold" icon={<IconEyeOff aria-hidden />}>
      {t("thread.staffOnly")}
    </Badge>
  ) : (
    <Badge tone="info" icon={<IconUsers aria-hidden />}>
      {t("thread.patientSees")}
    </Badge>
  );
}

const TONE: Record<string, Tone> = { returned: "hold", ask_physician: "warn", asked_physician: "warn", dispensed: "ok", ready: "ok", urgent: "danger" };

export function History({ rx }: { rx: RxRequest }) {
  const { t } = useTranslation("pharmacy");
  const locale = useLocale();
  const events = [...rx.timeline].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <Panel title={t("thread.history")}>
      <Timeline
        label={t("thread.history")}
        items={events.map((e, i) => ({
          id: `${e.at}:${i}`,
          time: formatDateTime(e.at, locale),
          dateTime: e.at,
          what: e.text,
          who: e.actor ? personName(e.actor) : t("thread.system"),
          tone: TONE[e.type],
          detail: e.visibility === "staff" ? <Who visibility="staff" /> : undefined,
        }))}
      />
    </Panel>
  );
}
