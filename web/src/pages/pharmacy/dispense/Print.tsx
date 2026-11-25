import "./print.css";

import { IconPrinter, IconReceipt, IconShoppingBag } from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { MedicationCard, RxItem, RxRequest } from "@/api/types";
import { useMe } from "@/data";
import { formatDate, PICKUP_HOURS } from "@/lib/format";
import { Button, Dialog, Menu, MenuItem, useLocale } from "@/ui";

import { drugName } from "../shared/names";
import { dispensable } from "./Facts";

type Sheet = "label" | "slip";

export function PrintMenu({ rx, cards, ageSex, today }: { rx: RxRequest; cards: MedicationCard[]; ageSex: string | null; today: string }) {
  const { t } = useTranslation("pharmacy");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const items = dispensable(rx);
  const content: ReactNode = sheet === "label" ? items.map((i) => <Label key={i.id} rx={rx} item={i} card={cards.find((c) => c.prescription_id === i.prescription_id)} ageSex={ageSex} today={today} />) : sheet === "slip" ? <Slip rx={rx} items={items} today={today} /> : null;
  return (
    <>
      <Menu
        trigger={
          <Button icon={<IconPrinter aria-hidden />} disabled={items.length === 0}>
            {t("print.menu")}
          </Button>
        }
      >
        <MenuItem icon={<IconShoppingBag aria-hidden />} onSelect={() => setSheet("label")}>
          {t("print.label")}
        </MenuItem>
        <MenuItem icon={<IconReceipt aria-hidden />} onSelect={() => setSheet("slip")}>
          {t("print.slip")}
        </MenuItem>
      </Menu>
      <Dialog
        open={sheet !== null}
        onOpenChange={(o) => !o && setSheet(null)}
        title={sheet ? t(`print.${sheet}`) : ""}
        description={sheet ? t(`print.${sheet}Note`) : undefined}
        footer={
          <>
            <Button onClick={() => setSheet(null)}>{t("print.close")}</Button>
            <Button variant="primary" icon={<IconPrinter aria-hidden />} onClick={() => window.print()}>
              {t("print.print")}
            </Button>
          </>
        }
      >
        {content}
      </Dialog>
      {sheet !== null && createPortal(<div className="print-sheet" aria-hidden="true">{content}</div>, document.body)}
    </>
  );
}

function Label({ rx, item, card, ageSex, today }: { rx: RxRequest; item: RxItem; card: MedicationCard | undefined; ageSex: string | null; today: string }) {
  const { t } = useTranslation("pharmacy");
  const locale = useLocale();
  const me = useMe();
  const rows: [string, ReactNode][] = [
    [t("print.dose"), item.dose_text],
    [t("print.days"), card ? t("dispense.daysN", { count: card.days_per_fill }) : t("print.notGiven")],
    [t("print.date"), formatDate(today, locale, "long")],
    [t("print.pharmacist"), me ? [me.display_name, me.title].filter(Boolean).join(" ") : t("print.notGiven")],
    [t("print.no"), rx.no],
    [t("print.missing"), t("print.missingList")],
  ];
  return (
    <div className="slip">
      <div className="slip-head">
        <span>{rx.pharmacy?.name ?? t("print.noPharmacy")}</span>
        <b>{t("print.demo")}</b>
      </div>
      <div className="slip-big">
        <span>
          {rx.patient.display_name}
          {ageSex ? t("print.paren", { text: ageSex }) : ""}
        </span>
        <strong>{drugName(item.drug, locale)}</strong>
      </div>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="slip-foot">
        {rx.pharmacy ? `${rx.pharmacy.address}${t("sentenceGap")}` : ""}
        {t("print.labelFoot")}
      </p>
    </div>
  );
}

function Slip({ rx, items, today }: { rx: RxRequest; items: RxItem[]; today: string }) {
  const { t } = useTranslation("pharmacy");
  const { t: tr } = useTranslation("rx");
  const locale = useLocale();
  const w = rx.pickup_window;
  const rows: [string, ReactNode][] = [
    [t("print.patient"), rx.patient.display_name],
    [t("print.when"), w ? `${formatDate(w.date, locale, "full")} ${tr(`pickupSlot.${w.slot}`)} ${PICKUP_HOURS[w.slot].join(t("print.to"))}` : t("print.notGiven")],
    [t("print.where"), rx.pharmacy ? [rx.pharmacy.name, rx.pharmacy.address, rx.pharmacy.hours].filter(Boolean).join(t("sentenceGap")) : t("print.notGiven")],
    [t("print.items"), items.map((i) => drugName(i.drug, locale)).join(t("listSep"))],
    [t("print.status"), tr(`status.${rx.status}`)],
    [t("print.bring"), t("print.bringBody")],
    [t("print.printed"), formatDate(today, locale, "long")],
  ];
  return (
    <div className="slip">
      <div className="slip-head">
        <span>{t("print.slip")}</span>
        <b>{t("print.demo")}</b>
      </div>
      <div className="slip-big">
        <span>{t("print.no")}</span>
        <strong>{rx.no}</strong>
      </div>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="slip-foot">{t("print.slipFoot")}</p>
    </div>
  );
}
