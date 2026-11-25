import { IconChecklist } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { HealthProfile, MedicationCard } from "@/api/types";
import { useMedications, useProfile } from "@/data";
import { Button, Checkbox, Field, Sheet, StatusTag, Textarea } from "@/ui";

import { useFmt } from "../shared";

interface Fact {
  id: string;
  name: string;
  source: string;
}
type GroupKey = "conditions" | "medications" | "allergies";

function collect(profile: HealthProfile | undefined, meds: MedicationCard[] | undefined, drugName: (m: MedicationCard) => string): Record<GroupKey, Fact[]> {
  const active = (items: HealthProfile["conditions"] | undefined): Fact[] => (items ?? []).filter((i) => i.status === "active").map((i) => ({ id: i.id, name: i.name, source: i.source }));
  const cards: Fact[] = (meds ?? []).filter((m) => m.state !== "expired").map((m) => ({ id: m.prescription_id, name: drugName(m), source: m.source }));
  const names = new Set(cards.map((c) => c.name));
  return {
    conditions: active(profile?.conditions),
    medications: [...cards.filter((c, i) => cards.findIndex((x) => x.name === c.name) === i), ...active(profile?.medications).filter((m) => !names.has(m.name))],
    allergies: active(profile?.allergies),
  };
}

const GROUPS: readonly GroupKey[] = ["conditions", "medications", "allergies"];

/**
 * What the health record already knows, to confirm instead of being asked again. Ticks mean "still right"; the result
 * is one message in the patient's own name, so the assistant and the doctor see what was confirmed.
 */
export function Facts({ onSend, onDismiss }: { onSend: (text: string) => void; onDismiss: () => void }) {
  const { t } = useTranslation("patient");
  const f = useFmt();
  const profile = useProfile();
  const meds = useMedications();
  const [open, setOpen] = useState(false);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [extra, setExtra] = useState("");
  if (!profile.data) return null;
  const facts = collect(profile.data, meds.data, (m) => f.drug(m.drug));
  const total = GROUPS.reduce((n, g) => n + facts[g].length, 0);
  if (total === 0) return null;

  const send = () => {
    const lines = [t("facts.msgLead")];
    for (const g of GROUPS) {
      const kept = facts[g].filter((x) => !off.has(x.id)).map((x) => x.name);
      const gone = facts[g].filter((x) => off.has(x.id)).map((x) => x.name);
      lines.push(t(`facts.msg_${g}`, { items: kept.length ? f.list(kept) : t("facts.msgNone") }));
      if (gone.length) lines.push(t("facts.msgGone", { items: f.list(gone) }));
    }
    if (extra.trim()) lines.push(t("facts.msgExtra", { text: extra.trim() }));
    onSend(lines.join("\n"));
    setOpen(false);
  };

  return (
    <div className="prefill">
      <IconChecklist size={22} className="flex-none text-ink-text" aria-hidden />
      <span>{t("facts.lead", { conditions: facts.conditions.length, medications: facts.medications.length, allergies: facts.allergies.length })}</span>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t("facts.title")}
        description={t("facts.body")}
        trigger={
          <Button size="sm" variant="soft">
            {t("facts.open")}
          </Button>
        }
        footer={
          <Button variant="primary" block onClick={send}>
            {t("facts.send")}
          </Button>
        }
      >
        <div className="facts">
          {GROUPS.map((g) => (
            <div key={g} className="facts-group" role="group" aria-label={t(`facts.${g}`)}>
              <p>{t(`facts.${g}`)}</p>
              <div>
                {facts[g].length === 0 && <p className="py-2 text-fg-3">{t("facts.noneOnRecord")}</p>}
                {facts[g].map((x) => (
                  <Checkbox
                    key={x.id}
                    label={x.name}
                    hint={<StatusTag family="source" status={x.source} plain />}
                    checked={!off.has(x.id)}
                    onCheckedChange={(c) => {
                      const next = new Set(off);
                      if (c === true) next.delete(x.id);
                      else next.add(x.id);
                      setOff(next);
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4">
          <Field label={t("facts.extra")} hint={t("facts.extraHint")} optional>
            <Textarea rows={2} value={extra} onChange={(e) => setExtra(e.target.value)} />
          </Field>
        </div>
      </Sheet>
      <Button size="sm" variant="quiet" onClick={onDismiss}>
        {t("facts.later")}
      </Button>
    </div>
  );
}
