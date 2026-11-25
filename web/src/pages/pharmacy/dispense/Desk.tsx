import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import { ApiError } from "@/api/errors";
import type { MedicationCard, PharmacyAction, PharmacyChecks, PharmacyInput, RxRequest } from "@/api/types";
import { allChecked, needsNote, PHARMACY_CHECKS, refillRefusal, staleRx, useAssignRx, useMe, usePharmacyAction } from "@/data";
import { paths } from "@/lib/links";
import { allows } from "@/lib/rx";
import { Banner, Button, Checkbox, Dialog, Field, Kbd, Panel, Textarea, toast, useHotkey, useLocale } from "@/ui";

import { useBoard } from "../board";
import { drugName } from "../shared/names";
import { Problem } from "../shared/problem";
import { dispensable } from "./Facts";
import type { PatientFacts } from "./PatientPanel";

const MAX_NOTE = 500;

/** Ticks survive a reload in this tab; they are sent, and checked by the server, only with the hand-over. */
function useChecks(id: string): [Partial<PharmacyChecks>, (c: Partial<PharmacyChecks>) => void] {
  const key = `pv-checks:${id}`;
  const [value, setValue] = useState<Partial<PharmacyChecks>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? "{}") as Partial<PharmacyChecks>;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      if (Object.keys(value).length === 0) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* kept for this visit only */
    }
  }, [key, value]);
  return [value, setValue];
}

export function Desk({ rx, cards, facts, stage }: { rx: RxRequest; cards: MedicationCard[]; facts: PatientFacts; stage: string | null }) {
  const { t } = useTranslation("pharmacy");
  const { t: tr } = useTranslation("rx");
  const locale = useLocale();
  const navigate = useNavigate();
  const me = useMe();
  const act = usePharmacyAction(rx.id);
  const assign = useAssignRx();
  const board = useBoard();
  const [checks, setChecks] = useChecks(rx.id);
  const [asking, setAsking] = useState<"return" | "ask_physician" | null>(null);
  const [note, setNote] = useState("");
  const [noteMissing, setNoteMissing] = useState(false);

  const working = rx.status === "at_pharmacy" || rx.status === "ready";
  const left = PHARMACY_CHECKS.filter((k) => checks[k] !== true).length;
  const mine = rx.assigned_to?.id === me?.id;
  const take = rx.status === "at_pharmacy" && rx.assigned_to?.role !== "pharmacist" && allows(rx, "assign");
  const items = dispensable(rx);
  const stale = staleRx(act.error);
  const refusal = refillRefusal(act.error);

  // The next one in the stage this was opened from, so a counter can work down the list.
  const list = board.rows[(stage ?? "check") as keyof typeof board.rows] ?? [];
  const next = list.find((r) => r.id !== rx.id);

  const run = (action: PharmacyAction, o: { note?: string } = {}) => {
    if (action === "dispense" && !allChecked(checks)) return;
    const input: PharmacyInput = { revision: rx.revision, action, note: o.note ?? null };
    if (action === "dispense" && allChecked(checks)) input.checks = checks;
    act.mutate(input, {
      onSuccess: () => {
        if (action === "dispense" || action === "return") setChecks({});
        setAsking(null);
        setNote("");
        toast.ok(t(`done.${action}`, { no: rx.no }), next && (action === "dispense" || action === "return" || action === "ask_physician") ? { action: { label: t("done.next"), onClick: () => void navigate(paths.pharmacy.rx(next.id), { state: { stage } }) } } : undefined);
      },
      onError: (e) => {
        // The record moved on: the reason belongs on the page, not inside a dialog about an old state.
        if (staleRx(e)) setAsking(null);
      },
    });
  };

  useHotkey("1", () => toggle("identity"), working);
  useHotkey("2", () => toggle("allergy"), working);
  useHotkey("3", () => toggle("interaction"), working);
  useHotkey("4", () => toggle("quantity"), working);
  function toggle(k: keyof PharmacyChecks) {
    setChecks({ ...checks, [k]: checks[k] !== true });
  }

  const days = (id: string) => cards.find((c) => c.prescription_id === id)?.days_per_fill;
  const means: Record<keyof PharmacyChecks, string> = {
    identity: t("check.identity", { name: rx.patient.display_name }),
    allergy: facts.allergies === null ? t("check.allergyLoading") : facts.allergies.length === 0 ? t("check.allergyNone") : t("check.allergy", { list: facts.allergies.map((a) => a.name).join(t("listSep")) }),
    interaction:
      facts.others === null
        ? t("check.interactionLoading")
        : facts.sameClass.length > 0
          ? t("check.interactionSame", { count: facts.others.length, list: facts.sameClass.map((m) => drugName(m.drug, locale)).join(t("listSep")) })
          : t("check.interaction", { count: facts.others.length }),
    quantity: items
      .map((i) => (days(i.prescription_id) ? t("check.quantityItem", { drug: drugName(i.drug, locale), count: days(i.prescription_id) }) : t("check.quantityUnknown", { drug: drugName(i.drug, locale) })))
      .join(t("sentenceGap")),
  };

  const busy = act.isPending ? act.variables.action : null;
  const any = allows(rx, "accept") || allows(rx, "ready") || allows(rx, "dispense") || allows(rx, "return") || allows(rx, "ask_physician") || take;

  return (
    <Panel
      title={working ? t("check.title") : t("check.titleActions")}
      footer={
        any ? (
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              {take && (
                <Button variant="primary" loading={assign.isPending} onClick={() => me && assign.mutate({ id: rx.id, account: { id: me.id, display_name: me.display_name, role: me.role, title: me.title, avatar: me.avatar } }, { onSuccess: () => toast.ok(t("done.accept", { no: rx.no })) })}>
                  {tr("pharmacyAction.accept")}
                </Button>
              )}
              {allows(rx, "accept") && (
                <Button variant="primary" loading={busy === "accept"} onClick={() => run("accept")}>
                  {tr("pharmacyAction.accept")}
                </Button>
              )}
              {allows(rx, "ready") && (
                <Button variant={take ? "secondary" : "primary"} loading={busy === "ready"} onClick={() => run("ready")}>
                  {tr("pharmacyAction.ready")}
                </Button>
              )}
              {allows(rx, "dispense") && (
                <Button variant="primary" disabled={left > 0} loading={busy === "dispense"} aria-describedby="checks-left" onClick={() => run("dispense")}>
                  {tr("pharmacyAction.dispense")}
                </Button>
              )}
              {allows(rx, "return") && <Button onClick={() => setAsking("return")}>{tr("pharmacyAction.return")}</Button>}
              {allows(rx, "ask_physician") && <Button onClick={() => setAsking("ask_physician")}>{tr("pharmacyAction.ask_physician")}</Button>}
            </div>
            {allows(rx, "dispense") && (
              <p id="checks-left" className="text-sm text-fg-2" role="status">
                {left > 0 ? t("check.left", { count: left }) : t("check.ready")}
              </p>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="grid gap-3">
        <StatusNote rx={rx} mine={mine} />
        {stale && (
          <Banner tone="warn" role="alert" title={t("stale.title")}>
            {t("stale.body", { status: tr(`status.${stale.status}`) })}
          </Banner>
        )}
        {refusal && (
          <Banner tone="warn" role="alert" title={refusal.title}>
            {refusal.message} {t("check.refusedNext")}
          </Banner>
        )}
        {act.error && !stale && !refusal && asking === null ? <Problem error={act.error} /> : null}
        {assign.error ? <Problem error={assign.error} /> : null}
        {working && (
          <>
            {rx.status === "at_pharmacy" && <p className="text-fg-2">{t("check.early")}</p>}
            <ol className="grid gap-1">
              {PHARMACY_CHECKS.map((k, i) => (
                <li key={k} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 border-b border-rule py-1 last:border-0">
                  <Checkbox label={tr(`check.${k}`)} hint={means[k]} checked={checks[k] === true} onCheckedChange={() => toggle(k)} />
                  <Kbd className="mt-1.5 hidden lg:inline-flex">{i + 1}</Kbd>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>

      <Dialog
        open={asking !== null}
        onOpenChange={(o) => {
          if (o) return;
          setAsking(null);
          setNoteMissing(false);
          act.reset();
        }}
        title={asking ? t(`ask.${asking}.title`, { no: rx.no }) : ""}
        description={asking ? t(`ask.${asking}.body`) : undefined}
        footer={
          <>
            <Button onClick={() => setAsking(null)}>{t("ask.back")}</Button>
            <Button
              variant="primary"
              loading={act.isPending}
              onClick={() => {
                if (!asking) return;
                const text = note.trim();
                if (needsNote(asking) && !text) {
                  setNoteMissing(true);
                  return;
                }
                run(asking, { note: text });
              }}
            >
              {asking ? t(`ask.${asking}.confirm`) : ""}
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <Field label={asking ? t(`ask.${asking}.label`) : ""} hint={asking ? t(`ask.${asking}.hint`) : undefined} error={noteMissing && !note.trim() ? t("ask.missing") : act.error instanceof ApiError ? act.error.fields.note : undefined} required>
            <Textarea rows={4} value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} autoFocus />
          </Field>
          {act.error && asking && !(act.error instanceof ApiError && act.error.fields.note) ? <Problem error={act.error} /> : null}
        </div>
      </Dialog>
    </Panel>
  );
}

/** What this state means and who acts next, in one sentence. */
function StatusNote({ rx, mine }: { rx: RxRequest; mine: boolean }) {
  const { t } = useTranslation("pharmacy");
  const returned = rx.status === "returned" ? [...rx.timeline].reverse().find((e) => e.type === "returned") : undefined;
  const key = rx.status === "at_pharmacy" ? (rx.assigned_to?.role !== "pharmacist" ? "new" : mine ? "mine" : "other") : rx.status;
  return (
    <div>
      <p>{t(`state.${key}`, { name: rx.assigned_to?.display_name ?? "", defaultValue: t("state.closed") })}</p>
      {returned && <p className="mt-1 text-fg-2">{returned.text}</p>}
    </div>
  );
}
