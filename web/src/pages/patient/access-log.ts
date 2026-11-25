/** The log stores codes ("read" + "visit", "rx.read"); patients read words. */
export function resourceKey(action: string, resource: string): string {
  const text = `${action} ${resource}`.toLowerCase();
  if (text.includes("note")) return "note";
  if (text.includes("rx") || text.includes("續開") || text.includes("領藥")) return "rx";
  if (text.includes("visit") || text.includes("預問診")) return "visit";
  if (text.includes("medication") || text.includes("用藥")) return "medications";
  if (text.includes("measure")) return "measurements";
  if (text.includes("appointment") || text.includes("schedule")) return "appointment";
  if (text.includes("patient") || text.includes("profile")) return "profile";
  return "other";
}
