import { useTranslation } from "react-i18next";

import type { MedicationCard, RxItem, RxRequest } from "@/api/types";
import { formatDate, formatDateRange, formatDateTime } from "@/lib/format";
import { Badge, DataTable, FormSheet, Panel, RefillStrip, StatusTag, useLocale } from "@/ui";

import { drugName, className, personName } from "../shared/names";
import { SourceLink } from "../shared/RuleViews";

/** The items this pharmacy may hand out: everything in a refill, only what the physician agreed to in a renewal. */
export function dispensable(rx: RxRequest): RxItem[] {
  return rx.kind === "refill" ? rx.items : rx.items.filter((i) => i.decision?.outcome === "approve");
}
export function leftOut(rx: RxRequest): RxItem[] {
  return rx.items.filter((i) => !dispensable(rx).includes(i));
}

/** One medicine as the prescription says it, and its dispensing cells. */
export function ItemFacts({ rx, item, card, today }: { rx: RxRequest; item: RxItem; card: MedicationCard | undefined; today: string }) {
  const { t } = useTranslation("pharmacy");
  const locale = useLocale();
  const nextFill = card ? card.fills.length + 1 : null;
  return (
    <div className="grid gap-3">
      <FormSheet
        title={t("dispense.sheet")}
        note={rx.no}
        columns={2}
        items={[
          {
            label: t("dispense.drug"),
            value: (
              <span className="text-lg font-bold">
                {drugName(item.drug, locale)}
                {item.drug.controlled_level > 0 && (
                  <Badge tone="hold" className="ms-2">
                    {t("formulary.levelN", { n: item.drug.controlled_level })}
                  </Badge>
                )}
              </span>
            ),
            wide: true,
          },
          { label: t("dispense.dose"), value: item.dose_text, wide: true },
          { label: t("dispense.class"), value: className(item.drug, locale), wide: true },
          ...(card
            ? [
                { label: t("dispense.days"), value: <span className="num text-lg font-bold">{t("dispense.daysN", { count: card.days_per_fill })}</span> },
                {
                  label: t("dispense.fill"),
                  value: <span className="num">{rx.kind === "refill" ? (nextFill !== null && nextFill <= card.fills_allowed ? t("dispense.fillN", { n: nextFill, total: card.fills_allowed }) : t("dispense.fillDone", { total: card.fills_allowed })) : t("dispense.fillNew")}</span>,
                },
                { label: t("dispense.issued"), value: <span className="num">{formatDate(card.issued_on, locale, "short")}</span> },
                { label: t("dispense.valid"), value: <span className="num">{formatDate(card.valid_until, locale, "short")}</span> },
                {
                  label: t("dispense.window"),
                  value: card.next_window ? <span className="num">{formatDateRange(card.next_window.from, card.next_window.to, locale)}</span> : t("dispense.noWindow"),
                  wide: true,
                },
              ]
            : [{ label: t("dispense.record"), value: t("dispense.noCard"), wide: true }]),
        ]}
      />
      {card && card.source === "clinic" && (
        <Panel>
          <RefillStrip med={card} today={today} />
        </Panel>
      )}
    </div>
  );
}

/** What the rules said and who decided: shown apart from the prescription itself. */
export function Checked({ rx }: { rx: RxRequest }) {
  const { t } = useTranslation("pharmacy");
  const locale = useLocale();
  const fired = rx.items.flatMap((i) => (i.engine?.fired ?? []).map((f, n) => ({ ...f, key: `${i.id}:${f.question_id}:${n}`, drug: drugName(i.drug, locale) })));
  const answer = (a: unknown) => (typeof a === "boolean" ? t(a ? "dispense.yes" : "dispense.no") : a === null || a === undefined || a === "" ? t("dispense.noAnswer") : String(a));
  return (
    <Panel
      title={t("dispense.checked")}
      flush
      meta={
        rx.engine && (
          <>
            <StatusTag family="disposition" status={rx.engine.disposition} />
            <span>{t("dispense.protocol", { version: rx.engine.protocol_version, at: formatDateTime(rx.engine.evaluated_at, locale) })}</span>
          </>
        )
      }
    >
      <div className="grid gap-3 px-pane py-3">
        <p className="text-fg-2">{t("dispense.checkedNote")}</p>
        {rx.engine?.summary && <p>{rx.engine.summary}</p>}
        {rx.items
          .filter((i) => i.refill)
          .map((i) => (
            <div key={i.id}>
              <p className="font-medium">
                {rx.items.length > 1 ? `${drugName(i.drug, locale)}${t("colon")}` : ""}
                {i.refill!.title}
              </p>
              <p className="text-fg-2">{i.refill!.message}</p>
              {i.refill!.rules.length > 0 && (
                <ul className="mt-2 grid gap-1.5">
                  {i.refill!.rules.map((r) => (
                    <li key={r.key} className="text-sm">
                      {r.text} <SourceLink url={r.source_url} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
      </div>
      {fired.length > 0 && (
        <div className="border-t border-rule">
          <DataTable
            caption={t("dispense.fired")}
            rows={fired}
            rowKey={(f) => f.key}
            columns={[
              {
                id: "q",
                header: t("dispense.question"),
                cell: (f) => (
                  <>
                    <span className="block">{f.label}</span>
                    {rx.items.length > 1 && <span className="block text-sm text-fg-2">{f.drug}</span>}
                  </>
                ),
                card: "title",
              },
              { id: "a", header: t("dispense.answer"), cell: (f) => <span className="num font-medium">{answer(f.answer)}</span>, width: "7rem" },
              { id: "d", header: t("dispense.ruleSays"), cell: (f) => <StatusTag family="disposition" status={f.disposition} />, width: "9rem", card: "end" },
              { id: "r", header: t("dispense.reason"), cell: (f) => <span className="text-sm">{f.reason}</span>, hideBelow: "md" },
              { id: "s", header: t("rules.source"), cell: (f) => <SourceLink url={f.source_url} />, width: "10rem", hideBelow: "lg" },
            ]}
          />
        </div>
      )}
    </Panel>
  );
}

/** Items the physician did not agree to: named, so nobody wonders why they are not on the sheet. */
export function NotDispensed({ items }: { items: RxItem[] }) {
  const { t } = useTranslation("pharmacy");
  const locale = useLocale();
  if (items.length === 0) return null;
  return (
    <Panel title={t("dispense.leftOut")} meta={<span>{t("dispense.leftOutNote")}</span>}>
      <ul className="divide-y divide-rule">
        {items.map((i) => (
          <li key={i.id} className="grid gap-1 py-2 first:pt-0 last:pb-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{drugName(i.drug, locale)}</span>
              {i.decision && <StatusTag family="outcome" status={i.decision.outcome} />}
            </span>
            {i.decision ? (
              <span className="text-sm text-fg-2">
                {t("dispense.decidedBy", { name: personName(i.decision.by), at: formatDateTime(i.decision.at, locale) })}
                {i.decision.note ? ` ${i.decision.note}` : ""}
              </span>
            ) : (
              <span className="text-sm text-fg-2">{t("dispense.noDecision")}</span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
