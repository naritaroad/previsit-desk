import { IconBuildingStore, IconListCheck, IconStethoscope, IconUser, type Icon } from "@tabler/icons-react";
import { useState } from "react";

import { Segmented } from "@/ui";

import { useCopy } from "./common";

interface Stop {
  ws: "patient" | "program" | "clinic" | "pharmacy";
  who: string;
  what: string;
  /** The request never gets here. */
  skip?: boolean;
  /** Outside this system: a visit in person. */
  offline?: boolean;
}
interface Scenario {
  id: string;
  label: string;
  stops: Stop[];
}

const ICON: Record<Stop["ws"], Icon> = { patient: IconUser, program: IconListCheck, clinic: IconStethoscope, pharmacy: IconBuildingStore };
/** Each station prints in the ink of its workspace; the program, which decides nothing, in the administrator's grey. */
const INK = { patient: "patient", program: "admin", clinic: "clinic", pharmacy: "pharmacy" } as const;

export function RenewalPath() {
  const { t, ts } = useCopy();
  const scenarios = ts<Scenario[]>("home.renewal.scenarios");
  const [id, setId] = useState(scenarios[0].id);
  const current = scenarios.find((s) => s.id === id) ?? scenarios[0];
  return (
    <div className="path">
      <Segmented label={t("home.renewal.label")} value={current.id} onValueChange={setId} options={scenarios.map((s) => ({ value: s.id, label: s.label }))} className="path-tabs" />
      <ol className="path-stops" aria-live="polite">
        {current.stops.map((s, i) => {
          const StopIcon = ICON[s.ws];
          return (
            <li key={`${current.id}-${i}`} data-ws={INK[s.ws]} data-skip={s.skip} data-offline={s.offline}>
              <span className="path-who">
                <StopIcon size={20} aria-hidden />
                {s.who}
              </span>
              <p>{s.what}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
