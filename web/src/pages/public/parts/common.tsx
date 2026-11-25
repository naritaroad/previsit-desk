import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn, Photo, Phrases } from "@/ui";

/** A list or table from public.json. `ts` is also what the copy check looks for. */
export function useCopy() {
  const { t } = useTranslation("public");
  const ts = <T,>(key: string): T => t(key, { returnObjects: true }) as T;
  return { t, ts };
}

/** Heading on the left, content on the right: the site's default grid. */
export function SplitRow({ title, aside, children, id, className }: { title: string; aside?: ReactNode; children: ReactNode; id?: string; className?: string }) {
  return (
    <section id={id} className={cn("pub-split", className)}>
      <div className="pub-split-head">
        <h2 className="pub-h2">
          <Phrases text={title} />
        </h2>
        {aside}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

type Slot = "medicine_table" | "consultation" | "city_taiwan" | "waiting" | "doctor_desk" | "pharmacy" | "clinic_corridor" | "bp_home" | "notes_hand" | "nature_calm" | "hero";

/** A photograph with its one-line caption from public.json and the photographer. */
export function PhotoNote({ slot, className, ...rest }: { slot: Slot; ratio?: string; sizes?: string; priority?: boolean; className?: string }) {
  const { t } = useTranslation("public");
  return (
    <div className={className}>
      <Photo slot={slot} caption={<>{t(`photo.${slot}`)} </>} credit {...rest} />
    </div>
  );
}

/** Opening of an inner page: title, one paragraph, and room for a picture or a form on the right. */
export function Opening({ title, lede, children, aside }: { title: string; lede?: ReactNode; children?: ReactNode; aside?: ReactNode }) {
  return (
    <header className={cn("pub-opening", Boolean(aside) && "with-aside")}>
      <div className="min-w-0">
        <h1 className="pub-h1" tabIndex={-1}>
          <Phrases text={title} />
        </h1>
        {lede && <p className="pub-lede">{lede}</p>}
        {children}
      </div>
      {aside && <div className="min-w-0">{aside}</div>}
    </header>
  );
}

/** The two telephone numbers, outside of any alert: red because it is the one thing red is for. */
export function CallRow() {
  const { t } = useTranslation("common");
  return (
    <div className="pub-calls">
      <a href="tel:119">
        <b className="num">119</b>
        <span>{t("emergency.call119")}</span>
      </a>
      <a href="tel:1925">
        <b className="num">1925</b>
        <span>{t("emergency.call1925")}</span>
      </a>
    </div>
  );
}
